const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { liveFixtures, installSupabaseStub, assertLayout } = require("./profiles.browser.cjs");

const baseUrl = process.env.SCHOLA_TEST_URL || "http://127.0.0.1:8000";

// This is a shared transport fixture, not a replacement test for Postgres scoring or RLS.
function classroomServer() {
  const fixture = liveFixtures("teacher", true);
  const tables = fixture.tables;
  tables.teacher_streams = tables.teacher_streams.slice(0, 1);
  tables.classrooms = tables.classrooms.slice(0, 1);
  tables.class_members = tables.class_members.filter((row) => row.class_id === tables.classrooms[0].id);
  for (const name of ["chapters", "chapter_classes", "chapter_questions", "question_answer_keys", "match_questions", "match_player_questions", "match_question_keys"]) tables[name] = [];
  let mode = null;
  let release;
  const calls = [];
  const result = (data) => ({ data, error: null });
  const server = {
    fixture, tables, calls,
    setMode(value) { mode = value; },
    release() { release?.(); },
    async rpc(userId, name, args) {
      calls.push({ userId, name, args });
      if (name === "save_chapter") {
        assert.equal(userId, "teacher-live");
        assert.equal(args.p_questions.length, 15);
        tables.chapters.push({ id: "workflow-chapter", stream_id: args.p_stream_id, title: args.p_title, subject: args.p_subject, published_at: new Date().toISOString(), created_at: new Date().toISOString() });
        tables.chapter_classes = args.p_class_ids.map((class_id) => ({ chapter_id: "workflow-chapter", class_id }));
        tables.chapter_questions = args.p_questions.map((q, position) => ({ ...q, id: `q-${position}`, chapter_id: "workflow-chapter", position }));
        tables.question_answer_keys = args.p_questions.map((q, position) => ({ question_id: `q-${position}`, correct_option_index: q.correct_option_index, explanation: q.explanation }));
        return result({ chapter_id: "workflow-chapter" });
      }
      if (name === "get_teacher_chapter_progress") {
        return result(tables.match_attempts.filter((a) => a.submitted_at).map((a) => ({ stream_id: args.p_stream_id, chapter_id: "workflow-chapter", user_id: a.user_id, match_count: 1, submitted_count: 1, correct_count: a.user_id === "student-live" ? 5 : 0, question_count: 5, win_count: a.user_id === "student-live" ? 1 : 0 })));
      }
      if (name === "create_challenge") {
        tables.challenges.push({ id: "workflow-challenge", chapter_id: args.p_chapter_id, challenger_id: userId, opponent_id: args.p_opponent_id, status: "pending", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 10800000).toISOString() });
        return result({ status: "pending" });
      }
      if (name === "accept_challenge") {
        const challenge = tables.challenges[0];
        if (challenge.status === "accepted") return result({ status: "accepted" });
        challenge.status = "accepted";
        const match = { id: "workflow-match", chapter_id: challenge.chapter_id, stream_id: tables.teacher_streams[0].id, player_one_id: challenge.challenger_id, player_two_id: challenge.opponent_id, status: "active", started_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 300000).toISOString() };
        tables.matches.push(match);
        tables.match_questions = tables.chapter_questions.slice(0, 5).map((q) => ({ ...q, id: `match-${q.id}`, match_id: match.id }));
        tables.match_question_keys = tables.match_questions.map((q) => ({ match_question_id: q.id, correct_option_index: 0, explanation: "Verified explanation" }));
        tables.match_player_questions = [match.player_one_id, match.player_two_id].flatMap((id) => tables.match_questions.map((q) => ({ match_id: match.id, user_id: id, match_question_id: q.id, display_order: id === match.player_one_id ? [0, 1, 2, 3] : [2, 0, 3, 1] })));
        return result({ status: "active", match_id: match.id });
      }
      if (name === "refresh_match") {
        const match = tables.matches.find((m) => m.id === args.p_match_id);
        return result({ ...match, server_now: mode === "short-timer" ? new Date(new Date(match.deadline_at).getTime() - 3000).toISOString() : new Date().toISOString() });
      }
      if (name === "submit_match_answers") {
        if (mode === "offline") throw new Error("Failed to fetch");
        if (mode === "server-error") return { data: null, error: { message: "Could not submit your answers." } };
        if (mode === "delayed") await new Promise((resolve) => { release = resolve; });
        if (tables.match_attempts.some((a) => a.user_id === userId)) return { data: null, error: { message: "Answers for this match have already been submitted." } };
        tables.match_attempts.push({ match_id: args.p_match_id, user_id: userId, answers: args.p_answers, submitted_at: new Date().toISOString() });
        const match = tables.matches[0];
        if (tables.match_attempts.length === 2) {
          Object.assign(match, { status: "completed", winner_id: "student-live", scores: { "student-live": 5, "opponent-live": 0 }, rating_changes: { "student-live": 16, "opponent-live": -16 }, resolved_at: new Date().toISOString() });
          tables.stream_ratings = [{ stream_id: match.stream_id, user_id: "student-live", rating: 1016 }, { stream_id: match.stream_id, user_id: "opponent-live", rating: 984 }];
        }
        if (mode === "lost-response") throw new Error("Failed to fetch");
        return result({ ...match, waiting_for_opponent: match.status === "active" });
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  return server;
}

async function run() {
  const screenshotDir = process.env.SCHOLA_SCREENSHOT_DIR || path.join(os.tmpdir(), "schola-workflow-smoke");
  await fs.mkdir(screenshotDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.env.SCHOLA_BROWSER_CHANNEL || "chrome" });
  let checks = 0;
  try {
    for (const width of [1440, 390, 320].filter((width) => !process.env.SCHOLA_TEST_WIDTH || width === Number(process.env.SCHOLA_TEST_WIDTH))) {
      const server = classroomServer();
      const errors = [];
      const contexts = [];
      const open = async (userId, existingContext = null) => {
        const context = existingContext || await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 } });
        if (!existingContext) contexts.push(context);
        const page = await context.newPage();
        page.on("dialog", (dialog) => dialog.accept());
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) => {
          const url = route.request().url();
          if (url.startsWith(baseUrl)) return process.env.SCHOLA_TEST_OFFLINE ? route.fulfill({ body: require("node:fs").readFileSync(path.join(__dirname, "..", new URL(url).pathname === "/" ? "index.html" : new URL(url).pathname)), contentType: new URL(url).pathname.endsWith(".js") ? "application/javascript" : new URL(url).pathname.endsWith(".css") ? "text/css" : "text/html" }) : route.continue();
          if (/cdn\.jsdelivr\.net/.test(url)) return route.fulfill({ status: 200, body: "" });
          errors.push(`Unexpected network: ${url}`);
          return route.abort();
        });
        await page.exposeFunction("__workflowRows", (name) => {
          if (name === "match_question_keys") assert.equal(server.tables.matches[0]?.status, "completed", "Answer keys must not be requested before completion");
          return server.tables[name];
        });
        await page.exposeFunction("__workflowRPC", (name, args) => server.rpc(userId, name, args));
        const fixtures = structuredClone(server.fixture);
        fixtures.userId = userId;
        fixtures.role = userId === "teacher-live" ? "teacher" : "student";
        await page.addInitScript(installSupabaseStub, fixtures);
        await page.goto(baseUrl);
        await page.locator("#liveRefresh").waitFor();
        return page;
      };
      const teacher = await open("teacher-live");
      await teacher.locator("#liveCreateChapter").click();
      await teacher.locator("#liveChapterTitle").fill("Reliability chapter");
      await teacher.locator("#liveChapterSubject").fill("Science");
      for (let index = 0; index < 15; index += 1) {
        await teacher.locator("#livePrompt").fill(`Question ${index + 1}`);
        for (let option = 0; option < 4; option += 1) await teacher.locator(`#liveOption${option}`).fill(`Choice ${option + 1}`);
        await teacher.locator("#liveAddQuestion").click();
      }
      const firstQuestion = teacher.locator('[data-question="0"]');
      await firstQuestion.locator('summary').click();
      assert.equal(await firstQuestion.locator('[name="prompt"]').inputValue(), "Question 1");
      await firstQuestion.locator('[name="prompt"]').fill("Edited first question");
      await firstQuestion.locator('[name="option1"]').fill("Revised choice");
      await firstQuestion.locator('[name="explanation"]').fill("Updated explanation");
      await firstQuestion.locator('[data-apply-question]').click();
      assert.equal(await teacher.locator("[data-question]").count(), 15);
      await firstQuestion.locator('summary').click();
      assert.equal(await firstQuestion.locator('[name="option1"]').inputValue(), "Revised choice");
      await firstQuestion.locator('[name="prompt"]').fill("Cancelled edit");
      await firstQuestion.locator('[data-cancel-question]').click();
      assert.match(await firstQuestion.locator('summary').innerText(), /Edited first question/);
      assert.doesNotMatch(await firstQuestion.locator('summary').innerText(), /Cancelled edit/);
      const secondQuestion = teacher.locator('[data-question="1"]');
      await secondQuestion.locator('summary').click();
      await secondQuestion.locator('[name="prompt"]').fill("Edited second question");
      assert.equal(await teacher.locator('#livePrompt').inputValue(), "");
      await assertLayout(teacher, 'question-editor-' + width, true);
      await teacher.screenshot({path:path.join(screenshotDir, 'question-editor-' + width + '.png')});
      await teacher.locator("#livePublish").click();
      await teacher.locator('[data-edit-chapter="workflow-chapter"]').waitFor();
      assert.equal(server.calls.filter((call) => call.name === "save_chapter").length, 1);
      assert.equal(server.tables.chapter_questions.length, 15);
      assert.equal(server.tables.chapter_questions[0].prompt, "Edited first question");
      assert.equal(server.tables.chapter_questions[1].prompt, "Edited second question");
      await teacher.locator('[data-edit-chapter="workflow-chapter"]').click();
      await teacher.locator('[data-question="0"] summary').click();
      assert.equal(await firstQuestion.locator('[name="prompt"]').inputValue(), "Edited first question");
      assert.equal(await firstQuestion.locator('[name="explanation"]').inputValue(), "Updated explanation");
      await teacher.locator("#liveCloseChapter").click();
      let first = await open("student-live");
      const second = await open("opponent-live");
      await first.locator('[data-live-challenge="workflow-chapter"]').click();
      await first.locator("#liveChallengeForm button[type=submit]").click();
      await first.locator("#modalBackdrop").waitFor({ state: "hidden" });
      await second.locator("#liveRefresh").click();
      await second.locator('[data-live-tab="matches"]').click();
      await second.locator('[data-live-accept="workflow-challenge"]').click();
      await second.locator("#leaveQuiz").click();
      await second.locator('[data-live-match="workflow-match"]').waitFor();
      assert.equal(server.tables.matches.length, 1);
      await first.locator("#liveRefresh").click();
      await first.locator('[data-live-tab="matches"]').click();
      const play = async (page) => {
        await page.locator('[data-live-tab="matches"]').click();
        await page.locator('[data-live-panel="matches"] [data-live-match="workflow-match"]').click();
        await page.locator("#nextQuestion").waitFor();
      };
      await play(first);
      await first.locator('[data-answer="0"]').click();
      await first.locator("#nextQuestion").click();
      await first.reload();
      await first.locator("#liveRefresh").waitFor();
      await play(first);
      assert.match(await first.locator(".quiz-progress-head").innerText(), /Question 2 of 5/);
      await assertLayout(first, `restored-quiz-${width}`, true);
      await first.screenshot({ path: path.join(screenshotDir, `restored-quiz-${width}.png`) });
      const firstContext = first.context();
      await first.close();
      first = await open("student-live", firstContext);
      await play(first);
      assert.match(await first.locator(".quiz-progress-head").innerText(), /Question 2 of 5/, "Restore answers after closing and reopening a tab");
      await first.locator("#previousQuestion").click();
      assert.equal(await first.locator('[data-answer="0"].selected').count(), 1);
      await first.locator("#nextQuestion").click();
      for (let index = 1; index < 5; index += 1) {
        await first.locator('[data-answer="0"]').click();
        if (index < 4) await first.locator("#nextQuestion").click();
      }
      for (const mode of ["offline", "server-error"]) {
        server.setMode(mode);
        await first.locator("#nextQuestion").click();
        await first.waitForFunction(() => !document.querySelector("#nextQuestion").disabled);
        assert.equal(server.tables.match_attempts.length, 0);
        assert.equal(await first.locator('[data-answer="0"].selected').count(), 1);
      }
      server.setMode("delayed");
      const before = server.calls.filter((call) => call.name === "submit_match_answers").length;
      await first.locator("#nextQuestion").click();
      await first.waitForFunction(() => document.querySelector("#nextQuestion").disabled);
      await first.evaluate(() => document.querySelector("#nextQuestion").click());
      assert.equal(server.calls.filter((call) => call.name === "submit_match_answers").length, before + 1, "Double click must not submit twice");
      server.release();
      await first.locator("#modalBackdrop").waitFor({ state: "hidden" });
      assert.equal(server.tables.match_attempts.length, 1);
      assert.equal(await first.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("schola-match-draft:")).length), 0);
      await play(second);
      for (let index = 0; index < 5; index += 1) {
        await second.locator('[data-answer="0"]').click();
        if (index < 4) await second.locator("#nextQuestion").click();
      }
      server.setMode("lost-response");
      await second.locator("#nextQuestion").click();
      await second.waitForFunction(() => !document.querySelector("#nextQuestion").disabled);
      assert.equal(server.tables.match_attempts.length, 2);
      server.setMode(null);
      await second.reload();
      await second.locator("#liveRefresh").waitFor();
      await second.locator('[data-live-tab="history"]').click();
      await second.locator('[data-live-panel="history"] [data-live-match="workflow-match"]').click();
      await second.locator(".result-summary").waitFor();
      assert.match(await second.locator(".result-summary").innerText(), /0 \/ 5[\s\S]*5 \/ 5/);
      assert.match(await second.locator(".rating-summary").innerText(), /-16 ELO/);
      assert.equal(await second.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("schola-match-draft:")).length), 0);
      await assertLayout(second, `opponent-result-${width}`, true);
      await second.screenshot({ path: path.join(screenshotDir, `opponent-result-${width}.png`) });
      await first.reload();
      await first.locator("#liveRefresh").waitFor();
      await first.locator('[data-live-tab="history"]').click();
      await first.locator('[data-live-panel="history"] [data-live-match="workflow-match"]').click();
      await first.locator(".result-summary").waitFor();
      assert.match(await first.locator(".result-summary").innerText(), /5 \/ 5[\s\S]*0 \/ 5/);
      assert.match(await first.locator(".rating-summary").innerText(), /\+16 ELO/);
      await first.locator("#closeMatchResult").click();
      assert.match(await first.locator(".rating-overview").innerText(), /1016/);
      await teacher.locator("#liveRefresh").click();
      await teacher.locator('[data-live-tab="results"]').click();
      await teacher.waitForFunction(() => document.querySelector('[data-live-panel="results"]').innerText.includes("5 / 5"));
      assert.match(await teacher.locator('[data-live-panel="results"]').innerText(), /5 \/ 5[\s\S]*0 \/ 5/);
      await assertLayout(teacher, `teacher-progress-${width}`);
      // Start another fixture attempt to exercise invalid local state and late responses.
      server.tables.match_attempts = [];
      Object.assign(server.tables.matches[0], { status: "active", scores: null, rating_changes: null });
      await first.reload();
      await first.locator("#liveRefresh").waitFor();
      await first.evaluate(() => localStorage.setItem("schola-match-draft:student-live:workflow-match", "corrupted"));
      await play(first);
      assert.match(await first.locator(".quiz-progress-head").innerText(), /Question 1 of 5/);
      assert.equal(await first.locator(".answer-option.selected").count(), 0);
      await first.locator("#leaveQuiz").click();
      const fingerprint = JSON.stringify(server.tables.match_questions.map((q) => [q.id, [0, 1, 2, 3]]));
      await first.evaluate(({ fingerprint, deadline }) => {
        localStorage.setItem("schola-match-draft:opponent-live:workflow-match", JSON.stringify({ fingerprint, deadline, answers: [0, 0, 0, 0, 0] }));
        localStorage.setItem("schola-match-draft:student-live:workflow-match", JSON.stringify({ fingerprint: "old-question-order", deadline, answers: [0, 0, 0, 0, 0] }));
      }, { fingerprint, deadline: new Date(server.tables.matches[0].deadline_at).getTime() });
      await play(first);
      assert.equal(await first.locator(".answer-option.selected").count(), 0, "Ignore another account's answers and mismatched question order");
      await first.locator("#leaveQuiz").click();
      await first.evaluate(() => localStorage.setItem("schola-match-draft:student-live:workflow-match", JSON.stringify({ deadline: Date.now() - 1, answers: [0, 0, 0, 0, 0] })));
      await play(first);
      assert.equal(await first.evaluate(() => localStorage.getItem("schola-match-draft:student-live:workflow-match")), null, "Remove expired answers");
      await first.evaluate(() => localStorage.setItem("schola-match-draft:student-live:signout-cleanup", JSON.stringify({ deadline: Date.now() + 60000, answers: [0] })));
      await first.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Storage disabled"); }; });
      for (let index = 0; index < 5; index += 1) {
        await first.locator('[data-answer="0"]').click();
        if (index < 4) await first.locator("#nextQuestion").click();
      }
      server.setMode("delayed");
      await first.evaluate(() => { window.__workflowSettled = null; });
      await first.locator("#nextQuestion").click();
      await first.waitForFunction(() => document.querySelector("#nextQuestion").disabled);
      await first.evaluate(() => window.__emitMockAuth(null));
      await first.locator("#authForm").waitFor();
      server.release();
      await first.waitForFunction(() => window.__workflowSettled === "submit_match_answers");
      assert.equal(await first.locator("#authForm").count(), 1);
      assert.equal(await first.locator("#nextQuestion").count(), 0, "Late submission must not reopen a signed-out account");
      assert.equal(await first.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("schola-match-draft:student-live:")).length), 0, "Sign-out clears this account's unsent answers");
      // A read-only refresh response for an expired match must not reopen the quiz.
      server.setMode(null);
      Object.assign(server.tables.matches[0], { status: "no_contest", winner_id: null });
      await second.locator("#closeMatchResult").click();
      await second.locator("#liveRefresh").click();
      await second.locator('[data-live-tab="history"]').click();
      await second.locator('[data-live-panel="history"] [data-live-match="workflow-match"]').click();
      await second.locator("#closeMatchStatus").waitFor();
      assert.match(await second.locator("#modal").innerText(), /No contest[\s\S]*do not change ELO/);
      server.tables.match_attempts = [];
      Object.assign(server.tables.matches[0], { status: "active", deadline_at: new Date(Date.now() + 300000).toISOString() });
      server.setMode("short-timer");
      const timedPage = await open("student-live");
      await timedPage.clock.install({ time: new Date("2035-01-01T00:00:00Z") });
      await play(timedPage);
      assert.match(await timedPage.locator("#matchDeadline").innerText(), /Time left 0:0[1-3]/, "Use server time even when device clock is wrong");
      await timedPage.locator('[data-answer="0"]').click();
      const submissionsBeforeExpiry = server.calls.filter((call) => call.name === "submit_match_answers").length;
      Object.assign(server.tables.matches[0], { status: "no_contest" });
      await timedPage.clock.fastForward(3000);
      await timedPage.locator("#closeMatchStatus").waitFor();
      assert.equal(await timedPage.locator("#nextQuestion").count(), 0, "Close answering interface at deadline");
      assert.equal(server.calls.filter((call) => call.name === "submit_match_answers").length, submissionsBeforeExpiry, "Do not submit late or incomplete answers");
      assert.deepEqual(errors, [], "No uncaught errors or remote writes");
      for (const context of contexts) await context.close();
      checks += 1;
      console.log(`PASS classroom-workflow-${width}: publish, duel, reload, network retry, duplicate prevention, lost response, scores, ELO, teacher progress, invalid drafts, account isolation, storage denial, sign-out, expiry, server clock, countdown`);
    }
    console.log(`${checks} full classroom workflows passed; screenshots: ${screenshotDir}`);
  } finally { await browser.close(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
