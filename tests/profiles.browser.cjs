const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { chromium } = require("playwright");

const baseUrl = process.env.SCHOLA_TEST_URL || "http://127.0.0.1:8000";
const screenshotDir = path.join(os.tmpdir(), "schola-profile-smoke");
const timestamp = "2026-10-01T12:00:00Z";
const streams = [
  { id: "stream-history", name: "History stream", owner_user_id: "teacher-live", created_at: timestamp },
  { id: "stream-science", name: "Science stream", owner_user_id: "teacher-live", created_at: timestamp },
];
const classrooms = [
  { id: "class-history", name: "Grade 11A", stream_id: streams[0].id, created_at: timestamp },
  { id: "class-science", name: "Grade 11B", stream_id: streams[1].id, created_at: timestamp },
];
const people = [
  { id: "teacher-live", display_name: "Test Teacher", role: "teacher" },
  { id: "student-live", display_name: "Alexandra Konstantinovna", role: "student" },
  { id: "opponent-live", display_name: "Sasha", role: "student" },
];
const chapters = [
  { id: "chapter-history", stream_id: streams[0].id, title: "World History", subject: "History", published_at: timestamp, created_at: timestamp },
  { id: "chapter-science", stream_id: streams[1].id, title: "Scientific Discoveries", subject: "Science", published_at: timestamp, created_at: timestamp },
];

function liveFixtures(role, zeroMatches = false) {
  const fixtureMatches = [
    { id: "match-one", chapter_id: chapters[0].id, stream_id: streams[0].id, player_one_id: "student-live", player_two_id: "opponent-live", status: "completed", winner_id: "student-live", started_at: "2026-10-05T12:00:00Z", resolved_at: "2026-10-05T13:00:00Z", rating_changes: { "student-live": 16, "opponent-live": -16 } },
    { id: "match-two", chapter_id: chapters[1].id, stream_id: streams[1].id, player_one_id: "opponent-live", player_two_id: "student-live", status: "completed", winner_id: "opponent-live", started_at: "2026-10-04T12:00:00Z", resolved_at: "2026-10-04T13:00:00Z", rating_changes: { "student-live": -12, "opponent-live": 12 } },
  ];
  return {
    role,
    userId: role === "teacher" ? "teacher-live" : "student-live",
    tables: {
      teacher_streams: streams,
      classrooms,
      user_profiles: people,
      chapters,
      class_members: classrooms.flatMap((classroom) => people.filter((person) => person.role === "student").map((person) => ({ class_id: classroom.id, user_id: person.id, joined_at: timestamp, classrooms: classroom }))),
      chapter_classes: chapters.map((chapter, index) => ({ chapter_id: chapter.id, class_id: classrooms[index].id })),
      chapter_questions: chapters.flatMap((chapter) => Array.from({ length: 15 }, (_, index) => ({ id: `${chapter.id}-${index}`, chapter_id: chapter.id }))),
      class_invites: [],
      challenges: [],
      matches: zeroMatches ? [] : fixtureMatches,
      match_attempts: zeroMatches ? [] : fixtureMatches.map((match) => ({ match_id: match.id, user_id: "student-live", answers: [0, 1, 2, 3, 0], submitted_at: match.resolved_at })),
      stream_ratings: zeroMatches ? [] : [
        { stream_id: streams[0].id, user_id: "student-live", rating: 1264 },
        { stream_id: streams[1].id, user_id: "student-live", rating: 1132 },
        { stream_id: streams[0].id, user_id: "opponent-live", rating: 980 },
        { stream_id: streams[1].id, user_id: "opponent-live", rating: 1012 },
      ],
    },
    progress: zeroMatches ? [] : [
      { stream_id: streams[0].id, chapter_id: chapters[0].id, user_id: "student-live", match_count: 1, submitted_count: 1, correct_count: 7, question_count: 10, win_count: 1 },
      { stream_id: streams[1].id, chapter_id: chapters[1].id, user_id: "student-live", match_count: 1, submitted_count: 1, correct_count: 4, question_count: 5, win_count: 0 },
    ],
  };
}

function installSupabaseStub(fixtures) {
  window.__mockWrites = [];
  window.__authCalls = [];
  if (fixtures.role === "connection-error") return;
  let currentSession = fixtures.role === "signed-out" ? null : { user: { id: fixtures.userId } };
  const blockedWrite = (name) => {
    window.__mockWrites.push(name);
    throw new Error(`Unexpected write in browser smoke test: ${name}`);
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: currentSession }, error: null }),
      signInWithPassword: async ({ email }) => {
        window.__authCalls.push("signIn");
        if (email === "wrong@example.com") return { error: { code: "invalid_credentials", message: "Invalid login credentials" } };
        if (email === "technical@example.com") return { error: { status: 500, message: "Supabase database error: SQL schema cache failed" } };
        currentSession = { user: { id: "student-live" } };
        return { data: { session: currentSession }, error: null };
      },
      signUp: async () => { window.__authCalls.push("signUp"); return { data: { session: null }, error: null }; },
      onAuthStateChange: (listener) => {
        window.__emitMockAuth = (session) => listener(session ? "SIGNED_IN" : "SIGNED_OUT", session);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signOut: async () => { currentSession = null; window.__authCalls.push("signOut"); return { error: null }; },
    },
    from(table) {
      let predicates = [];
      let ordering = null;
      let count = Infinity;
      let single = false;
      const query = {
        select() { return query; },
        eq(key, value) { predicates.push((row) => row[key] === value); return query; },
        in(key, values) { predicates.push((row) => values.includes(row[key])); return query; },
        gt(key, value) { predicates.push((row) => row[key] > value); return query; },
        not(key, operator, value) { if (operator !== "is") throw new Error(`Unsupported not ${operator}`); predicates.push((row) => row[key] !== value); return query; },
        or(expression) {
          const clauses = expression.split(",").map((clause) => clause.split(".eq."));
          predicates.push((row) => clauses.some(([key, value]) => row[key] === value));
          return query;
        },
        order(key, options = {}) { ordering = { key, ascending: options.ascending !== false }; return query; },
        limit(value) { count = value; return query; },
        maybeSingle() { single = true; return query; },
        insert() { return blockedWrite(`${table}.insert`); },
        update() { return blockedWrite(`${table}.update`); },
        delete() { return blockedWrite(`${table}.delete`); },
        then(resolve, reject) {
          try {
            if (!Object.hasOwn(fixtures.tables, table)) throw new Error(`Missing fixture table: ${table}`);
            let data = fixtures.tables[table].filter((row) => predicates.every((predicate) => predicate(row)));
            if (ordering) data.sort((a, b) => String(a[ordering.key]).localeCompare(String(b[ordering.key])) * (ordering.ascending ? 1 : -1));
            data = data.slice(0, count);
            const result = { data: single ? data[0] || null : data, error: null };
            if (table === "teacher_streams" && window.__pauseWorkspace) {
              return new Promise((resume) => {
                window.__resumeWorkspace = () => { window.__pauseWorkspace = false; resume(result); };
              }).then(resolve, reject);
            }
            return Promise.resolve(result).then(resolve, reject);
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
        },
      };
      return query;
    },
    rpc(name, args) {
      if (fixtures.role === "server-error") return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function public.get_teacher_chapter_progress in Supabase schema cache" } });
      if (name === "get_practice_questions") return Promise.resolve({ data: [
        { prompt: "First practice question", options: ["First", "Second", "Third", "Fourth"], correct_option_index: 0, explanation: "Practice explanation" },
        { prompt: "Second practice question", options: ["One", "Two", "Three", "Four"], correct_option_index: 1, explanation: "Second explanation" },
      ], error: null });
      if (name === "get_teacher_chapter_progress") return Promise.resolve({ data: fixtures.progress.filter((entry) => entry.stream_id === args.p_stream_id), error: null });
      return blockedWrite(`rpc.${name}`);
    },
  };
  window.supabase = { createClient: () => client };
}

async function assertLayout(page, label, modal = false) {
  const result = await page.evaluate((checkModal) => {
    const width = window.innerWidth;
    const result = { width, documentWidth: document.documentElement.scrollWidth };
    if (checkModal) {
      const element = document.querySelector("#modal");
      const bounds = element.getBoundingClientRect();
      result.modal = { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, height: window.innerHeight, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    }
    return result;
  }, modal);
  assert.ok(result.documentWidth <= result.width + 1, `${label}: horizontal page overflow ${JSON.stringify(result)}`);
  if (modal) {
    assert.ok(result.modal.left >= 0 && result.modal.right <= result.width + 1, `${label}: modal outside viewport ${JSON.stringify(result)}`);
    assert.ok(result.modal.top >= 0 && result.modal.bottom <= result.modal.height + 1, `${label}: modal vertical containment ${JSON.stringify(result)}`);
    assert.ok(result.modal.scrollWidth <= result.modal.clientWidth + 1, `${label}: modal content overflow ${JSON.stringify(result)}`);
  }
}

async function assertText(locator, pattern) {
  await locator.waitFor({ state: "visible" });
  assert.match(await locator.innerText(), pattern);
}

async function run() {
  await fs.mkdir(screenshotDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.env.SCHOLA_BROWSER_CHANNEL || "chrome" });
  const screenshots = [];
  let checks = 0;
  try {
    for (const width of [1440, 390, 320].filter((value) => !process.env.SCHOLA_TEST_WIDTH || value === Number(process.env.SCHOLA_TEST_WIDTH))) {
      for (const scenario of ["signed-out", "teacher", "student", "student-empty", "connection-error", "server-error", "profile-missing", "teacher-empty"].filter((value) => !process.env.SCHOLA_TEST_SCENARIO || value === process.env.SCHOLA_TEST_SCENARIO)) {
        const errors = [];
        const blockedNetwork = [];
        const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 }, locale: "en-US" });
        const page = await context.newPage();
        page.on("pageerror", (error) => { errors.push(error.message); console.error(`${scenario}-${width}: ${error.message}`); });
        const fixtures = liveFixtures(["teacher", "server-error", "profile-missing", "teacher-empty"].includes(scenario) ? "teacher" : "student", scenario === "student-empty");
        if (["signed-out", "connection-error", "server-error"].includes(scenario)) fixtures.role = scenario;
        if (scenario === "profile-missing") fixtures.tables.user_profiles = [];
        if (scenario === "teacher-empty") fixtures.tables.teacher_streams = [];
        await context.addInitScript(installSupabaseStub, fixtures);
        await context.addInitScript(() => localStorage.setItem("schola-clash-prototype-v2", JSON.stringify({ activeUserId: "old-demo-teacher", users: [{ id: "old-demo-teacher", name: "Old Demo Teacher", role: "teacher" }], sets: [], battles: [] })));
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.hostname === "cdn.jsdelivr.net") return route.fulfill({ contentType: "application/javascript", body: "/* The client is provided by the isolated test fixture. */" });
          if (url.pathname === "/supabase/client-config.js") return route.fulfill({ contentType: "application/javascript", body: 'window.SCHOLA_SUPABASE_CONFIG = { url: "https://test.invalid", publishableKey: "test-public-key" };' });
          if (url.origin === new URL(baseUrl).origin) return route.continue();
          blockedNetwork.push(url.origin);
          return route.abort();
        });
        const label = `${scenario}-${width}`;
        await page.goto(baseUrl, { waitUntil: "networkidle" });
        if (scenario === "signed-out") {
          await page.locator("#authForm").waitFor();
          assert.equal(await page.locator("#userSelect").count(), 0);
          assert.equal(await page.locator("[data-live-tab]").count(), 0);
          await page.locator("#toggleAuthMode").click();
          await page.locator("#authName").fill("New Student");
          await page.locator("#authEmail").fill("new@example.com");
          await page.locator("#authPassword").fill("validPassword123");
          await page.locator('#authForm button[type="submit"]').click();
          await assertText(page.locator("#authMessage"), /confirmation link/);
          await page.locator("#toggleAuthMode").click();
          await page.locator("#authEmail").fill("wrong@example.com");
          await page.locator("#authPassword").fill("validPassword123");
          await page.locator('#authForm button[type="submit"]').click();
          await assertText(page.locator("#authMessage"), /email or password is incorrect/);
          await page.locator("#authEmail").fill("technical@example.com");
          await page.locator('#authForm button[type="submit"]').click();
          await assertText(page.locator("#authMessage"), /couldn't sign you in/);
          assert.doesNotMatch(await page.locator("body").innerText(), /Supabase|schema cache|SQL/i);
          await page.locator("#authEmail").fill("student@example.com");
          await page.locator('#authForm button[type="submit"]').click();
          await assertText(page.locator(".rating-number").first(), /1264/);
          await page.locator("#authButton").click();
          await page.locator("#authForm").waitFor();
          assert.equal(await page.locator(".rating-overview").count(), 0);
          await page.reload({ waitUntil: "networkidle" });
          await page.locator("#authForm").waitFor();
          assert.equal(await page.locator("#userSelect").count(), 0);
        } else if (scenario === "connection-error") {
          await assertText(page.locator("#app"), /couldn't connect[\s\S]*internet connection/);
        } else if (scenario === "server-error" || scenario === "profile-missing") {
          await assertText(page.locator("#app"), /couldn't load/);
        } else if (scenario === "teacher-empty") {
          await page.locator("#liveCreateStream").click();
          await assertText(page.locator("#modalTitle"), /Create your teaching space/);
          await assertText(page.locator("#modal"), /Teaching space name/);
          await assertLayout(page, label, true);
          await page.getByRole("button", { name: "Close", exact: true }).click();
        } else if (scenario === "teacher") {
          await page.locator("#liveCreateChapter").click();
          await assertText(page.locator("#modalTitle"), /Create a chapter/);
          assert.equal(await page.locator("#liveUseStarter").count(), 0);
          assert.doesNotMatch(await page.locator("#modal").innerText(), /starter|demo|Supabase/i);
          await page.getByRole("button", { name: "Close", exact: true }).click();
          await page.locator('[data-live-tab="classes"]').click();
          const classesPath = path.join(screenshotDir, `${label}-classes.png`);
          await page.screenshot({ path: classesPath, fullPage: true });
          screenshots.push(classesPath);
          await page.locator('[data-live-panel="classes"] [data-student-profile="student-live"]').first().click();
          await assertText(page.locator("#modalTitle"), /Alexandra Konstantinovna/);
          await assertText(page.locator(".profile-rating-list"), /1264\s*ELO[\s\S]*History stream[\s\S]*1132\s*ELO[\s\S]*Science stream/);
          await assertText(page.locator(".profile-metrics"), /73%[\s\S]*11 \/ 15/);
          await assertText(page.locator(".profile-memberships"), /Grade 11A[\s\S]*Joined 10\/1\/2026[\s\S]*Grade 11B/);
          await assertText(page.locator(".student-profile"), /World History[\s\S]*Sasha[\s\S]*Won[\s\S]*\+16 ELO[\s\S]*Lost[\s\S]*-12 ELO/);
          await assertLayout(page, `${label}-profile`, true);
          const profilePath = path.join(screenshotDir, `${label}-profile.png`);
          await page.screenshot({ path: profilePath, fullPage: true });
          screenshots.push(profilePath);
          await page.getByRole("button", { name: "Close", exact: true }).click();
          await page.locator('[data-live-tab="results"]').click();
          await page.locator('[data-live-panel="results"] [data-student-profile="student-live"]').first().click();
          await assertText(page.locator("#modalTitle"), /Alexandra/);
          await page.keyboard.press("Escape");
          await page.locator("#modalBackdrop").waitFor({ state: "hidden" });
        } else {
          await page.locator(".rating-overview").first().waitFor();
          assert.equal(await page.locator(".rating-overview").count(), 2);
          await assertText(page.locator(".rating-overview").nth(0), scenario === "student-empty" ? /1000\s*ELO/ : /1264\s*ELO[\s\S]*\+16 ELO/);
          await assertText(page.locator(".rating-overview").nth(1), scenario === "student-empty" ? /1000\s*ELO/ : /1132\s*ELO[\s\S]*-12 ELO/);
          if (scenario === "student-empty") assert.doesNotMatch(await page.locator(".rating-overviews").innerText(), /undefined|NaN|[+-]0 ELO/);
          assert.ok((await page.locator(".rating-overview").first().boundingBox()).y < 600, "Live rating should be near the top");
          await page.locator("[data-live-practice]").first().click();
          await assertText(page.locator("#modalTitle"), /World History/);
          await page.locator("[data-answer]").first().click();
          await page.locator("#nextQuestion").click();
          await page.locator("[data-answer]").first().click();
          await page.locator("#nextQuestion").click();
          await assertText(page.locator("#modal"), /PRACTICE COMPLETE[\s\S]*Practice explanation/);
          await page.getByRole("button", { name: "Close", exact: true }).click();
        }
        await assertLayout(page, label);
        const screenshotPath = path.join(screenshotDir, `${label}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        screenshots.push(screenshotPath);
        if (scenario === "teacher") {
          await page.locator('[data-live-panel="results"] [data-student-profile="student-live"]').first().click();
          await page.evaluate(() => { window.__pauseWorkspace = true; window.__pendingRefresh = window.ScholaLiveApp.refresh(); });
          await page.waitForFunction(() => typeof window.__resumeWorkspace === "function");
          await page.evaluate(() => window.__emitMockAuth(null));
          await page.locator("#modalBackdrop").waitFor({ state: "hidden" });
          await page.locator("#authForm").waitFor();
          await page.evaluate(async () => { window.__resumeWorkspace(); await window.__pendingRefresh; });
          assert.equal(await page.locator("#authForm").count(), 1, "A late workspace response must not restore a signed-out account");
          assert.equal(await page.locator(".student-profile").count(), 0, "Signing out must remove the previous teacher profile");
        }
        assert.doesNotMatch(await page.locator("body").innerText(), /supabase|postgrest|schema cache|\\brpc\\b|prototype|demo workspace|demo profile|Old Demo Teacher/i);
        assert.equal(await page.locator("#userSelect").count(), 0);
        assert.deepEqual(errors, [], `${label}: page errors`);
        assert.deepEqual(await page.evaluate(() => window.__mockWrites), [], `${label}: unexpected writes`);
        assert.deepEqual(blockedNetwork, [], `${label}: unexpected external network`);
        checks += 1;
        console.log(`PASS ${label}`);
        await context.close();
      }
    }
    console.log(JSON.stringify({ checks, screenshots }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
