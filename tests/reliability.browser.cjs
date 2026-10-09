const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { liveFixtures, installSupabaseStub, assertLayout } = require("./profiles.browser.cjs");

function installReliabilityServer(fixture) {
  const tables = fixture.tables;
  tables.account_requests = [];
  tables.question_answer_keys = tables.chapter_questions.map((q, index) => ({ question_id: q.id, correct_option_index: 0, explanation: "Explanation " + index }));
  tables.chapter_questions.forEach((q, index) => Object.assign(q, { prompt: "Question " + index, options: ["Right", "Wrong B", "Wrong C", "Wrong D"], position: index + 1 }));
  window.__workflowRows = async (table) => {
    if (table === "account_requests" && window.__failRequestLoad) {
      window.__failRequestLoad = false;
      throw new Error("Network request failed");
    }
    return tables[table];
  };
  const original = window.supabase.createClient;
  window.supabase.createClient = () => {
    const client = original();
    const oldRPC = client.rpc;
    let progress = [], missed = [], failedPractice = false;
    window.__reliabilityCalls = [];
    client.auth.resend = async (args) => { window.__reliabilityCalls.push({ name: "resend", args }); return { error: null }; };
    client.rpc = async (name, args = {}) => {
      window.__reliabilityCalls.push({ name, args });
      const chapter = tables.chapters.find((row) => row.id === args.p_chapter_id);
      if (name === "report_client_error") return { error: null };
      if (name === "get_learning_progress_by_mode") return { data: progress, error: null };
      if (name === "manage_chapter") {
        if (args.p_action === "archive") chapter.archived_at = new Date().toISOString();
        if (args.p_action === "restore") chapter.archived_at = null;
        if (args.p_action === "unpublish") chapter.published_at = null;
        if (args.p_action === "copy") {
          const copy = { ...chapter, id: "copied-chapter", title: chapter.title + " (copy)", published_at: null, archived_at: null };
          tables.chapters.push(copy);
          tables.chapter_classes.push(...tables.chapter_classes.filter((row) => row.chapter_id === chapter.id).map((row) => ({ ...row, chapter_id: copy.id })));
          const questions = tables.chapter_questions.filter((row) => row.chapter_id === chapter.id);
          questions.forEach((q, index) => {
            const id = "copy-question-" + index;
            tables.chapter_questions.push({ ...q, id, chapter_id: copy.id });
            tables.question_answer_keys.push({ ...tables.question_answer_keys.find((key) => key.question_id === q.id), question_id: id });
          });
          return { data: copy.id, error: null };
        }
        return { data: chapter.id, error: null };
      }
      if (name === "manage_class") {
        const classroom = tables.classrooms.find((row) => row.id === args.p_class_id);
        if (args.p_action === "rename") classroom.name = args.p_name;
        classroom.archived_at = args.p_action === "archive" ? new Date().toISOString() : null;
        return { data: classroom.id, error: null };
      }
      if (name === "save_chapter_versioned") {
        if (window.__chapterConflict) return { error: { code: "SC001", message: "This chapter has changed in another window. Your edits are kept in this editor. Close it, refresh your workspace and reopen the chapter before saving." } };
        if (window.__pauseChapterSave) await new Promise((resolve) => { window.__resumeChapterSave = resolve; });
        Object.assign(chapter, { title: args.p_title, subject: args.p_subject, published_at: args.p_publish ? new Date().toISOString() : null, updated_at: new Date().toISOString() });
        tables.chapter_questions = tables.chapter_questions.filter((q) => q.chapter_id !== chapter.id);
        args.p_questions.forEach((q, index) => {
          const id = chapter.id + "-saved-" + index;
          tables.chapter_questions.push({ id, chapter_id: chapter.id, position: index, prompt: q.prompt, options: q.options });
          tables.question_answer_keys.push({ question_id: id, correct_option_index: q.correct_option_index, explanation: q.explanation });
        });
        return { data: chapter.id, error: null };
      }
      if (name === "request_account_action") {
        tables.account_requests.push({ id: "request-" + args.p_kind, user_id: fixture.userId, kind: args.p_kind, status: "pending", created_at: new Date().toISOString() });
        return { data: "request-" + args.p_kind, error: null };
      }
      if (name === "cancel_account_request") { tables.account_requests.find((request) => request.id === args.p_id).status = "cancelled"; return { error: null }; }
      if (name === "get_practice_questions") return { data: tables.chapter_questions.filter((q) => q.chapter_id === chapter.id).slice(0,2).map((q) => ({ ...q, correct_option_index: 0, explanation: "Practice explanation" })), error: null };
      if (name === "get_missed_practice_questions") return { data: missed, error: null };
      if (name === "submit_practice_round") {
        if (!failedPractice) { failedPractice = true; return { error: { status: 500, code: "server_error" } }; }
        const correct = args.p_answers.filter((answer) => answer.answer === 0).length;
        progress = progress.filter((entry) => entry.is_review !== args.p_review);
        progress.push({ chapter_id: chapter.id, user_id: fixture.userId, is_review: args.p_review, attempt_count: 1, latest_accuracy: Math.round(correct / args.p_answers.length * 100) });
        missed = args.p_answers.filter((answer) => answer.answer !== 0).map((answer) => ({ ...tables.chapter_questions.find((q) => q.id === answer.question_id), correct_option_index: 0, explanation: "Practice explanation" }));
        return { data: { correct_count: correct, question_count: args.p_answers.length }, error: null };
      }
      return oldRPC(name, args);
    };
    return client;
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.SCHOLA_BROWSER_CHANNEL || "chrome" });
  try {
    for (const width of [1440,390,320]) {
      const open = async (role) => {
        const context = await browser.newContext({ viewport: { width, height: 1000 } });
        const fixture = liveFixtures(role, true);
        fixture.tables.question_answer_keys = [];
        await context.addInitScript(installSupabaseStub, fixture);
        await context.addInitScript(installReliabilityServer, fixture);
        const page = await context.newPage();
        const errors = []; page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.hostname === "cdn.jsdelivr.net") return route.fulfill({ body: "", contentType: "application/javascript" });
          if (url.pathname === "/supabase/client-config.js") return route.fulfill({ body: 'window.SCHOLA_SUPABASE_CONFIG={url:"https://test.invalid",publishableKey:"test"}', contentType: "application/javascript" });
          if (url.hostname !== "127.0.0.1") return route.abort();
          return route.fulfill({ body: fs.readFileSync(path.join(__dirname,"..",url.pathname === "/" ? "index.html" : url.pathname)), contentType: url.pathname.endsWith(".js") ? "application/javascript" : url.pathname.endsWith(".css") ? "text/css" : "text/html" });
        });
        await page.goto("http://127.0.0.1:8000");
        await page.locator("#liveRefresh").waitFor();
        return { page, context, errors };
      };
      const { page: teacher, context: tc, errors: te } = await open("teacher");
      await teacher.locator('[data-edit-chapter="chapter-history"]').click();
      await teacher.locator("#liveCloseChapter").focus();
      await teacher.keyboard.press("Shift+Tab");
      assert.equal(await teacher.locator("#livePublish").evaluate((element) => element === document.activeElement), true);
      await teacher.keyboard.press("Tab");
      assert.equal(await teacher.locator("#liveCloseChapter").evaluate((element) => element === document.activeElement), true);
      const originalTitle = await teacher.locator("#liveChapterTitle").inputValue();
      await teacher.locator("#liveChapterTitle").fill("Temporary title");
      await teacher.waitForFunction(() => localStorage.getItem("schola-chapter-draft:teacher-live:chapter-history") !== null);
      await teacher.locator("#liveChapterTitle").fill(originalTitle);
      await teacher.waitForFunction(() => localStorage.getItem("schola-chapter-draft:teacher-live:chapter-history") === null);
      await teacher.locator("#liveChapterTitle").fill("Unsaved local chapter");
      await teacher.locator('[data-question="0"] summary').click();
      await teacher.locator('[data-question="0"] [name="prompt"]').fill("Unsaved inline question");
      await teacher.waitForFunction(() => JSON.parse(localStorage.getItem("schola-chapter-draft:teacher-live:chapter-history"))?.data.questions[0].prompt === "Unsaved inline question");
      teacher.once("dialog", (dialog) => dialog.dismiss());
      await teacher.locator("#accountButton").focus();
      await teacher.keyboard.press("Enter");
      assert.equal(await teacher.locator("#liveChapterTitle").count(), 1, "Declining modal replacement must keep the editor usable");
      assert.equal(await teacher.locator("#accountForm").count(), 0);
      teacher.once("dialog", (dialog) => dialog.dismiss());
      await teacher.locator("#liveCloseChapter").click();
      assert.equal(await teacher.locator("#liveChapterTitle").count(), 1);
      teacher.once("dialog", (dialog) => dialog.accept());
      await teacher.locator("#liveCloseChapter").click();
      await teacher.reload(); await teacher.locator('[data-edit-chapter="chapter-history"]').click();
      await teacher.evaluate(() => {
        window.__originalRemoveItem = Storage.prototype.removeItem;
        Storage.prototype.removeItem = () => { throw new DOMException("Storage blocked", "SecurityError"); };
      });
      await teacher.locator("#discardChapterDraft").click();
      await teacher.getByText("Could not discard the draft. Your browser may be blocking storage access.", {exact:true}).waitFor();
      await teacher.evaluate(() => { Storage.prototype.removeItem = window.__originalRemoveItem; });
      await teacher.locator("#restoreChapterDraft").click();
      assert.equal(await teacher.locator("#liveChapterTitle").inputValue(), "Unsaved local chapter");
      assert.match(await teacher.locator('[data-question="0"] summary').innerText(), /Unsaved inline question/);
      await assertLayout(teacher, "restored-editor-" + width, true);
      teacher.on("dialog", (dialog) => dialog.accept());
      await teacher.evaluate(() => { window.__chapterConflict = true; });
      await teacher.locator("#livePublish").click();
      await teacher.locator('#livePublishHint[role="alert"]').waitFor();
      assert.match(await teacher.locator("#livePublishHint").innerText(), /changed in another window/);
      assert.equal(await teacher.locator("#liveChapterTitle").inputValue(), "Unsaved local chapter");
      await teacher.evaluate(() => { window.__chapterConflict = false; });
      await teacher.evaluate(() => { window.__pauseChapterSave = true; });
      await teacher.locator("#livePublish").click();
      await teacher.waitForFunction(() => typeof window.__resumeChapterSave === "function");
      assert.equal(await teacher.locator("#liveChapterTitle").isDisabled(), true);
      await teacher.keyboard.press("Escape");
      assert.equal(await teacher.locator("#liveChapterTitle").count(), 1);
      await teacher.evaluate(() => { window.__pauseChapterSave = false; window.__resumeChapterSave(); });
      await teacher.locator("#modalBackdrop").waitFor({state:"hidden"});
      assert.equal(await teacher.evaluate(() => localStorage.getItem("schola-chapter-draft:teacher-live:chapter-history")), null);
      const act = async (page, selector) => {
        const button = page.locator(selector);
        await button.evaluate((element) => { for (let details = element.closest("details"); details; details = details.parentElement.closest("details")) details.open = true; });
        await button.click();
      };
      await act(teacher, '[data-manage-chapter="chapter-history"][data-action="unpublish"]');
      await teacher.locator('[data-edit-chapter="chapter-history"]').waitFor();
      assert.match(await teacher.locator('[data-edit-chapter="chapter-history"]').innerText(), /Continue draft/);
      await act(teacher, '[data-manage-chapter="chapter-history"][data-action="copy"]');
      await teacher.getByRole("heading", {name:"Edit draft"}).waitFor();
      assert.equal(await teacher.locator("#liveQuestionList [data-question]").count(), 15);
      await teacher.locator("#liveCloseChapter").click();
      await act(teacher, '[data-manage-chapter="chapter-history"][data-action="archive"]');
      await teacher.locator('[data-manage-chapter="chapter-history"][data-action="restore"]').waitFor({state:"attached"});
      assert.equal(await teacher.locator('[data-edit-chapter="chapter-history"]').count(), 0);
      await act(teacher, '[data-manage-chapter="chapter-history"][data-action="restore"]');
      await teacher.locator('[data-live-tab="classes"]').click();
      await act(teacher, '[data-manage-class="class-history"][data-action="rename"]');
      await teacher.locator("#renameClassName").fill("Renamed class");
      await teacher.locator('#renameClassForm button[type="submit"]').click();
      await teacher.getByRole("heading", {name:"Renamed class"}).waitFor();
      await act(teacher, '[data-manage-class="class-history"][data-action="archive"]');
      await teacher.locator('[data-manage-class="class-history"][data-action="restore"]').waitFor({state:"attached"});
      await act(teacher, '[data-manage-class="class-history"][data-action="restore"]');
      await teacher.locator('[data-live-tab="chapters"]').click();
      await teacher.locator('[data-edit-chapter="chapter-science"]').click();
      assert.equal(await teacher.locator('.live-check-list input[value="class-science"]').count(), 1);
      assert.equal(await teacher.locator('.live-check-list input[value="class-history"]').count(), 0);
      await teacher.locator("#livePublish").click();
      await teacher.locator("#modalBackdrop").waitFor({state:"hidden"});
      const scienceSave = await teacher.evaluate(() => window.__reliabilityCalls.find((call) => call.name === "save_chapter_versioned" && call.args.p_chapter_id === "chapter-science"));
      assert.equal(scienceSave.args.p_stream_id, "stream-science");
      await assertLayout(teacher, "teacher-materials-" + width);
      assert.deepEqual(te, []); await tc.close();

      const { page: student, context: sc, errors: se } = await open("student");
      await student.evaluate(() => { window.__failRequestLoad = true; });
      await student.locator("#accountButton").click();
      await student.locator("#retryAccountRequests").click();
      await student.getByText("No account requests yet.", {exact:true}).waitFor();
      await student.getByText("Request teacher access", {exact:true}).click();
      await student.locator("#teacherRequestNote").fill("Test school");
      await student.locator('[data-request-kind="teacher_access"] button').click();
      await student.locator('[data-cancel-request="request-teacher_access"]').waitFor();
      assert.equal(await student.locator('[data-request-kind="teacher_access"] button').isDisabled(), true);
      assert.equal(await student.evaluate(() => window.__reliabilityCalls.filter((call) => call.name === "request_account_action").length), 1);
      await student.locator('[data-cancel-request="request-teacher_access"]').click();
      await student.getByText("cancelled", {exact:true}).waitFor();
      assert.equal(await student.locator('[data-request-kind="teacher_access"] button').isDisabled(), false);
      await student.getByText("Request account deletion", {exact:true}).click();
      await student.locator('[data-request-kind="deletion"] input[type="checkbox"]').check();
      await student.locator('[data-request-kind="deletion"] button').click();
      await student.locator('[data-cancel-request="request-deletion"]').waitFor();
      await assertLayout(student, "account-requests-" + width, true);
      await student.locator("#closeAccount").click();
      await student.locator('[data-live-practice="chapter-history"]').click();
      await student.getByRole("button", {name:/Wrong B/}).click(); await student.locator("#nextQuestion").click();
      await student.getByRole("button", {name:/Right/}).click(); await student.locator("#nextQuestion").click();
      await student.getByText("Could not submit your answers. Please try again.", {exact:true}).waitFor();
      await student.locator("#nextQuestion").click();
      await student.locator("#reviewPracticeMistakes").waitFor();
      const attempts = await student.evaluate(() => window.__reliabilityCalls.filter((call) => call.name === "submit_practice_round"));
      assert.equal(attempts[0].args.p_attempt_id, attempts[1].args.p_attempt_id);
      await student.locator("#reviewPracticeMistakes").click();
      await student.getByText("Question 1 of 1", {exact:true}).waitFor();
      await student.getByRole("button", {name:/Right/}).click(); await student.locator("#nextQuestion").click();
      await student.getByText("All answers correct.", {exact:true}).waitFor();
      await student.getByRole("button", {name:"Close",exact:true}).click();
      await student.getByRole("heading", {name:"Your learning progress"}).waitFor();
      await student.getByRole("cell", {name:"Full practice",exact:true}).waitFor();
      await student.getByRole("cell", {name:"Mistake review",exact:true}).waitFor();
      await student.evaluate(() => window.scholaReportError("account", {code:"password=secret", message:"private text"}));
      const reports = await student.evaluate(() => window.__reliabilityCalls.filter((call) => call.name === "report_client_error"));
      assert.doesNotMatch(JSON.stringify(reports), /password=secret|private text/);
      await student.locator("#authButton").click();
      await student.locator("#authEmail").fill("resend@example.test");
      await student.locator("#resendConfirmation").click();
      await student.getByText(/If this account needs confirmation/).waitFor();
      await student.locator("#resendConfirmation").click();
      await student.getByText("Wait a minute before requesting another confirmation email.", {exact:true}).waitFor();
      assert.equal(await student.evaluate(() => window.__reliabilityCalls.filter((call) => call.name === "resend").length), 1);
      await assertLayout(student, "learning-progress-" + width);
      assert.deepEqual(se, []); await sc.close();
      console.log("PASS reliability " + width + ": draft recovery, close guard, material lifecycle, requests, practice retry and mistakes");
    }
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode=1; });
