const STORAGE_KEY = "schola-clash-prototype-v2";
const ANSWER_LABELS = ["A", "B", "C", "D"];
const DEMO_STREAM = "Marina’s classes";
const CHALLENGE_TTL_MS = 3 * 60 * 60 * 1000;
const MATCH_TTL_MS = 24 * 60 * 60 * 1000;
const ELO_K_FACTOR = 32;

const sampleQuestions = [
  ["In which year did World War I begin?", ["1912", "1914", "1916", "1918"], 1, "World War I began in 1914."],
  ["Which event was the immediate trigger for the war?", ["The First Battle of the Marne", "The assassination of Archduke Franz Ferdinand", "The October Revolution", "The Treaty of Versailles"], 1, "The assassination in Sarajevo triggered the July Crisis."],
  ["Which countries formed the core of the Triple Entente?", ["Germany, Austria-Hungary, Italy", "Russia, France, Great Britain", "The United States, Japan, Italy", "The Ottoman Empire, Germany, Bulgaria"], 1, "The core members were Russia, France, and Great Britain."],
  ["What was the pre-war alliance between Germany, Austria-Hungary, and Italy called?", ["The Holy Alliance", "The Triple Alliance", "The League of Nations", "The Central Council"], 1, "Italy left the Triple Alliance and joined the Allies in 1915."],
  ["On which front did Germany fight France?", ["The Eastern Front", "The Balkan Front", "The Western Front", "The Caucasus Front"], 2, "The Western Front ran through France and Belgium."],
  ["In which year did Italy join the war on the Allied side?", ["1914", "1915", "1916", "1917"], 1, "Italy entered the war on the Allied side in 1915."],
  ["Which weapons became widely used in trench warfare?", ["War elephants", "Tanks and machine guns", "Crossbows", "Rocket artillery"], 1, "Machine guns and, later, tanks became important weapons."],
  ["In which year did the United States enter the war?", ["1915", "1916", "1917", "1918"], 2, "The United States declared war on Germany in 1917."],
  ["Which revolution led to Russia leaving the war?", ["The February Revolution of 1917", "The Revolution of 1905", "The Revolutions of 1848", "The July Revolution"], 0, "After the 1917 revolutions, Russia began peace negotiations."],
  ["What was Soviet Russia’s peace treaty with the Central Powers called?", ["The Treaty of Versailles", "The Treaty of Brest-Litovsk", "The Treaty of Tilsit", "The Treaty of Saint-Germain"], 1, "The Treaty of Brest-Litovsk was signed in March 1918."],
  ["When was the armistice that ended the fighting signed?", ["November 11, 1918", "September 1, 1918", "June 28, 1919", "May 9, 1918"], 0, "The armistice took effect on November 11, 1918."],
  ["What was the post-war peace treaty with Germany called?", ["The Treaty of Brest-Litovsk", "The Treaty of Versailles", "The Treaty of Paris", "The Treaty of Lausanne"], 1, "The Treaty of Versailles was signed in 1919."],
  ["What was a defining feature of trench warfare?", ["Fast naval raids", "Long periods holding fortified lines", "The absence of artillery", "Fighting only in cities"], 1, "Trenches and fortified positions defined much of the Western Front."],
  ["Which empire dissolved after the war?", ["The British Empire", "The Austro-Hungarian Empire", "The Spanish Empire", "The Portuguese Empire"], 1, "Austria-Hungary dissolved at the end of the war."],
  ["What was one cause of World War I?", ["Imperial competition among major powers", "The discovery of the Americas", "The Reformation", "The founding of the United Nations"], 0, "Competition for influence and colonies heightened tensions."],
];
window.scholaSampleQuestions = sampleQuestions;

function createInitialState() {
  return {
    activeUserId: "teacher-1",
    users: [
      { id: "teacher-1", name: "Marina Ivanova", role: "teacher", stream: DEMO_STREAM },
      { id: "student-1", name: "Vasya", role: "student", className: "Grade 11B", stream: DEMO_STREAM },
      { id: "student-2", name: "Sasha", role: "student", className: "Grade 11A", stream: DEMO_STREAM },
      { id: "student-3", name: "Aliya", role: "student", className: "Grade 11B", stream: DEMO_STREAM },
      { id: "student-4", name: "Daniyar", role: "student", className: "Grade 11A", stream: DEMO_STREAM },
    ],
    sets: [{
      id: "set-world-war-one",
      title: "World War I",
      subject: "History",
      published: true,
      stream: DEMO_STREAM,
      classNames: ["Grade 11A", "Grade 11B"],
      questions: sampleQuestions,
    }],
    battles: [],
  };
}

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (stored && Array.isArray(stored.users) && Array.isArray(stored.sets) && Array.isArray(stored.battles)) return stored;
  } catch { /* Start with the sample workspace when local data is missing or invalid. */ }
  return createInitialState();
}

let state = loadState();
state.users.forEach((user) => {
  user.streamRatings ||= {};
  if (user.role === "student") user.streamRatings[user.stream] ??= Number.isFinite(user.elo) ? user.elo : 1000;
});
let stateMigrated = false;
state.battles.forEach((battle) => {
  // Migrate invitations created by the earlier prototype version.
  if (battle.status === "active" && battle.pendingFor) {
    battle.status = "pending";
    stateMigrated = true;
  } else if (battle.status === "active") {
    battle.acceptedAt ||= Date.now();
    battle.deadlineAt ||= battle.acceptedAt + MATCH_TTL_MS;
    stateMigrated = true;
  } else if (battle.status === "done") {
    battle.acceptedAt ||= battle.createdAt || Date.now();
  }
  battle.participants.forEach((userId) => {
    const attempt = battle.attempts?.[userId];
    if (!attempt || !Array.isArray(battle.questions)) return;
    if (!Array.isArray(attempt.optionOrders) || attempt.optionOrders.length !== battle.questions.length) {
      attempt.optionOrders = battle.questions.map((question) => question.options.map((_, index) => index));
      stateMigrated = true;
    }
  });
});
if (stateMigrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
const app = document.getElementById("app");
const userSelect = document.getElementById("userSelect");
const profilePicker = userSelect.closest(".profile-picker");
const roleBadge = document.getElementById("roleBadge");
const modalBackdrop = document.getElementById("modalBackdrop");
const modal = document.getElementById("modal");
const supabaseStatus = document.getElementById("supabaseStatus");
const authButton = document.getElementById("authButton");
const supabaseClient = window.scholaSupabase;
let activeBattleId = null;
let supabaseSession = null;
let supabaseProfile = null;
let supabaseProfileError = null;
let supabaseAuthReady = !supabaseClient;

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function processBattleDeadlines(now = Date.now()) {
  let changed = false;
  state.battles.forEach((battle) => {
    const createdAt = Number(battle.createdAt);
    if (battle.status === "pending" && (!Number.isFinite(createdAt) || now - createdAt >= CHALLENGE_TTL_MS)) {
      battle.status = "expired";
      battle.pendingFor = null;
      changed = true;
      return;
    }

    if (battle.status !== "active" || Number(battle.deadlineAt) > now) return;
    const [firstId, secondId] = battle.participants;
    const firstSubmitted = Boolean(battle.attempts[firstId]?.submitted);
    const secondSubmitted = Boolean(battle.attempts[secondId]?.submitted);
    if (firstSubmitted && secondSubmitted) {
      battle.status = "done";
      const firstScore = calculateScore(battle, firstId);
      const secondScore = calculateScore(battle, secondId);
      battle.winner = firstScore === secondScore ? null : firstScore > secondScore ? firstId : secondId;
      updateStreamRatings(battle);
    } else if (firstSubmitted || secondSubmitted) {
      battle.status = "forfeit";
      battle.winner = firstSubmitted ? firstId : secondId;
      battle.forfeitBy = firstSubmitted ? secondId : firstId;
    } else {
      battle.status = "void";
      battle.winner = null;
    }
    changed = true;
  });
  if (changed) saveState();
  return changed;
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function currentUser() {
  return state.users.find((person) => person.id === state.activeUserId) || state.users[0];
}

function findSet(setId) {
  return state.sets.find((questionSet) => questionSet.id === setId);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

function openModal(html) {
  modal.innerHTML = html;
  modalBackdrop.classList.add("show");
  modalBackdrop.setAttribute("aria-hidden", "false");
  modal.querySelector("button, input, select")?.focus();
}

function closeModal() {
  activeBattleId = null;
  modalBackdrop.classList.remove("show");
  modalBackdrop.setAttribute("aria-hidden", "true");
  modal.innerHTML = "";
}

function paintSupabaseStatus() {
  if (!supabaseClient) {
    supabaseStatus.textContent = "Supabase client unavailable";
    authButton.textContent = "Connection unavailable";
    authButton.disabled = true;
    return;
  }

  authButton.disabled = false;
  if (!supabaseSession) {
    supabaseStatus.textContent = "Supabase configured · demo data";
    supabaseStatus.title = "The client is configured. Sign in to check the database profile.";
    authButton.textContent = "Sign in";
    return;
  }

  if (supabaseProfile) {
    supabaseStatus.textContent = `Connected · live ${supabaseProfile.role} workspace`;
    supabaseStatus.title = `Signed in as ${supabaseProfile.display_name}. Classroom data is loaded from Supabase.`;
  } else {
    supabaseStatus.textContent = "Signed in · profile not loaded";
    supabaseStatus.title = supabaseProfileError || "No profile row was returned for this account.";
  }
  authButton.textContent = "Sign out";
}

async function refreshSupabaseSession(session = undefined) {
  if (!supabaseClient) return;
  let nextSession = session;
  if (nextSession === undefined) {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) {
      supabaseSession = null;
      supabaseProfile = null;
      supabaseProfileError = error.message;
      supabaseAuthReady = true;
      paintSupabaseStatus();
      render();
      return;
    }
    nextSession = data.session;
  }

  supabaseSession = nextSession;
  supabaseProfile = null;
  supabaseProfileError = null;
  if (supabaseSession?.user) {
    const { data, error } = await supabaseClient
      .from("user_profiles")
      .select("display_name, role")
      .eq("id", supabaseSession.user.id)
      .maybeSingle();
    if (error) supabaseProfileError = error.message;
    else if (!data) supabaseProfileError = "No profile row was returned for this account.";
    else supabaseProfile = data;
  }
  supabaseAuthReady = true;
  paintSupabaseStatus();
  render();
}

function openAuthModal(mode = "signin") {
  if (!supabaseClient) {
    showToast("Supabase client is not available. Check the internet connection and reload the page.");
    return;
  }

  const signingUp = mode === "signup";
  openModal(`<div class="modal-header"><div><p class="eyebrow">SUPABASE ACCOUNT</p><h2 id="modalTitle">${signingUp ? "Create a student account" : "Sign in to Schola Clash"}</h2></div><button class="button button-quiet" type="button" id="closeAuth">Close</button></div>
    <p class="modal-description">${signingUp ? "This creates a new Supabase account with the student role. A confirmation email may be required before sign-in." : "Sign in uses an existing account; choose “Create a student account” below if you have not registered yet."} The demo profiles below are separate from Supabase accounts.</p>
    <form id="authForm">
      ${signingUp ? `<div class="field"><label for="authName">Your name</label><input id="authName" name="displayName" autocomplete="name" maxlength="80" required></div>` : ""}
      <div class="field"><label for="authEmail">Email</label><input id="authEmail" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="authPassword">Password</label><input id="authPassword" name="password" type="password" autocomplete="${signingUp ? "new-password" : "current-password"}" minlength="8" required></div>
      <p class="small" id="authMessage" role="status" aria-live="polite"></p>
      <div class="modal-footer"><button class="button button-quiet" type="button" id="toggleAuthMode">${signingUp ? "Already have an account? Sign in" : "New here? Create a student account"}</button><div class="modal-actions"><button class="button button-primary" type="submit">${signingUp ? "Create account" : "Sign in"}</button></div></div>
    </form>`);

  document.getElementById("closeAuth").addEventListener("click", closeModal);
  document.getElementById("toggleAuthMode").addEventListener("click", () => openAuthModal(signingUp ? "signin" : "signup"));
  document.getElementById("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const message = document.getElementById("authMessage");
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    submit.disabled = true;
    message.textContent = "Connecting to Supabase…";

    let result;
    try {
      result = signingUp
        ? await supabaseClient.auth.signUp({
          email,
          password,
          options: { data: { display_name: form.elements.displayName.value.trim() } },
        })
        : await supabaseClient.auth.signInWithPassword({ email, password });
    } catch (error) {
      message.textContent = error.message || "Could not reach Supabase. Check your connection and try again.";
      submit.disabled = false;
      return;
    }

    if (result.error) {
      message.textContent = result.error.message;
      submit.disabled = false;
      return;
    }

    if (signingUp && !result.data.session) {
      message.textContent = `Account created in Supabase. Check ${email} for the confirmation link, then sign in here.`;
      submit.disabled = false;
      return;
    }

    await refreshSupabaseSession(result.data.session);
    closeModal();
    showToast(signingUp ? "Account connected to Supabase." : "Signed in to Supabase.");
  });
}

authButton.addEventListener("click", async () => {
  if (!supabaseClient) return openAuthModal();
  if (!supabaseSession) return openAuthModal();
  const { error } = await supabaseClient.auth.signOut();
  if (error) return showToast(error.message);
  await refreshSupabaseSession(null);
  showToast("Signed out of Supabase.");
});

if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => refreshSupabaseSession(session), 0);
  });
  refreshSupabaseSession();
} else {
  paintSupabaseStatus();
}

modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalBackdrop.classList.contains("show")) closeModal();
});

function updateProfilePicker() {
  if (supabaseClient && !supabaseAuthReady) {
    profilePicker.hidden = true;
    roleBadge.textContent = "Checking account…";
    return;
  }

  if (supabaseSession) {
    profilePicker.hidden = true;
    roleBadge.textContent = supabaseProfile?.role === "teacher" ? "Teacher" : "Student";
    return;
  }

  profilePicker.hidden = false;
  const person = currentUser();
  roleBadge.textContent = person.role === "teacher" ? "Teacher" : "Student";
  userSelect.innerHTML = state.users.map((profile) => {
    const label = profile.role === "teacher" ? `Teacher · ${profile.name}` : `${profile.name} · ${profile.className}`;
    return `<option value="${escapeHtml(profile.id)}" ${profile.id === person.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function render() {
  updateProfilePicker();
  if (supabaseClient && !supabaseAuthReady) {
    app.innerHTML = `${pageHeading("SUPABASE", "Checking your account", "Restoring your sign-in before loading the demo workspace.")}<div class="empty-state"><strong>Connecting…</strong></div>`;
    return;
  }
  if (supabaseSession) {
    if (window.ScholaLiveApp) {
      window.ScholaLiveApp.render({ session: supabaseSession, profile: supabaseProfile, profileError: supabaseProfileError });
      return;
    }
    app.innerHTML = `${pageHeading("SUPABASE", "Loading your classroom", "Connecting your account to the live workspace.")}<div class="empty-state"><strong>One moment…</strong></div>`;
    return;
  }
  processBattleDeadlines();
  const person = currentUser();
  if (!person) return;
  person.role === "teacher" ? renderTeacher(person) : renderStudent(person);
}

userSelect.addEventListener("change", () => {
  state.activeUserId = userSelect.value;
  saveState();
  closeModal();
  render();
});

function pageHeading(eyebrow, title, description, action = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="lede">${description}</p></div>${action}</div>`;
}

function statCard(icon, value, label) {
  return `<article class="stat-card"><span class="stat-icon" aria-hidden="true">${icon}</span><div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div></article>`;
}

function teacherStats(person, students, sets) {
  const published = sets.filter((questionSet) => questionSet.published).length;
  const completedMatches = state.battles.filter((battle) => ["done", "forfeit", "void"].includes(battle.status) && battle.participants.some((id) => students.some((student) => student.id === id))).length;
  return `<div class="stats-grid">${statCard("▤", published, "Published chapters")}${statCard("♙", students.length, "Students in your stream")}${statCard("⚔", completedMatches, "Resolved ranked matches")}</div>`;
}

function renderTeacher(person) {
  const students = state.users.filter((user) => user.role === "student" && user.stream === person.stream);
  const sets = state.sets.filter((questionSet) => questionSet.stream === person.stream);
  const action = `<button class="button button-primary" id="createSet"><span aria-hidden="true">＋</span> New chapter</button>`;

  app.innerHTML = `${pageHeading("TEACHER WORKSPACE", "Make every review count", "Turn your class materials into chapters, then see where students are growing.", action)}
    <section class="hero-banner" aria-label="Classroom overview">
      <div class="hero-copy"><p class="eyebrow">ONE STREAM · TWO CLASSROOMS</p><h2>Make room for a little friendly competition.</h2><p>Students in Grade 11A and Grade 11B can challenge one another on the same approved chapter.</p></div>
      <div class="hero-side"><span class="hero-side-label">Your stream invite code</span><strong class="hero-side-number">SCHOLA11</strong><span class="hero-side-note">Demo code only · demo workspace</span></div>
    </section>
    ${teacherStats(person, students, sets)}
    <nav class="tab-bar" aria-label="Teacher dashboard sections"><button class="tab-button active" data-tab="sets">Chapters</button><button class="tab-button" data-tab="results">Student results</button><button class="tab-button" data-tab="classes">My classes</button></nav>
    <section class="tab-panel active" id="panel-sets"><div class="section-heading"><div><h2>Your chapters</h2><p>Publish a chapter with at least 15 approved questions to unlock ranked matches.</p></div><span class="small">${sets.length} total</span></div><div class="card-grid">${sets.map(renderSetCard).join("") || emptyState("No chapters yet", "Create a chapter to give your students something to review.")}</div></section>
    <section class="tab-panel" id="panel-results"><div class="section-heading"><div><h2>Student results</h2><p>Ranked matches only. Practice sessions do not affect these numbers.</p></div></div>${renderTeacherResults(students, sets)}</section>
    <section class="tab-panel" id="panel-classes"><div class="section-heading"><div><h2>${escapeHtml(person.stream)}</h2><p>Students from parallel classes can be matched within this stream.</p></div><button class="button button-secondary" id="addStudent"><span aria-hidden="true">＋</span> Add demo student</button></div>${renderClasses(students)}</section>`;

  bindTabs();
  document.getElementById("createSet").addEventListener("click", () => openSetEditor());
  document.querySelectorAll("[data-edit-set]").forEach((button) => button.addEventListener("click", () => openSetEditor(button.dataset.editSet)));
  document.getElementById("addStudent").addEventListener("click", () => openAddStudent(person));
}

function renderSetCard(questionSet) {
  const questionCount = questionSet.questions.length;
  const setState = questionSet.published ? "Published" : "Draft";
  return `<article class="surface-card set-card"><div class="set-card-top"><span class="subject-tag">${escapeHtml(questionSet.subject || "Subject")}</span><span class="state-tag ${questionSet.published ? "published" : ""}">${setState}</span></div><span class="set-icon" aria-hidden="true">✳</span><h3>${escapeHtml(questionSet.title)}</h3><p class="set-meta">${questionCount} questions · ${escapeHtml(questionSet.classNames.join(" · "))}</p><div class="set-card-footer"><button class="button button-outline" data-edit-set="${escapeHtml(questionSet.id)}">Open chapter <span aria-hidden="true">↗</span></button></div></article>`;
}

function emptyState(title, detail) {
  return `<div class="empty-state"><strong>${title}</strong>${detail}</div>`;
}

function renderTeacherResults(students, sets) {
  if (!sets.length || !students.length) return emptyState("Results will appear here", "Publish a chapter and invite students to start collecting ranked match results.");

  const rows = rankedStudents(students).map((student) => {
    const matches = state.battles.filter((battle) => ["done", "forfeit", "void"].includes(battle.status) && battle.participants.includes(student.id) && sets.some((questionSet) => questionSet.id === battle.setId));
    const scoredMatches = matches.filter((battle) => battle.attempts[student.id].submitted);
    const correct = scoredMatches.reduce((total, battle) => total + calculateScore(battle, student.id), 0);
    const total = scoredMatches.reduce((sum, battle) => sum + battle.questions.length, 0);
    const wins = matches.filter((battle) => battle.winner === student.id).length;
    return `<tr><td><span class="rank-number ${studentRank(students, student.id) <= 3 ? "rank-top" : ""}">${studentRank(students, student.id)}</span></td><td><strong>${escapeHtml(student.name)}</strong><div class="small">${escapeHtml(student.className)}</div></td><td><strong class="leaderboard-rating">${getStreamRating(student.id)}</strong> ELO</td><td>${matches.length}</td><td><strong>${correct} / ${total}</strong></td><td>${wins}</td></tr>`;
  }).join("");

  return `<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Student</th><th>Stream rating</th><th>Ranked matches</th><th>Correct answers</th><th>Wins</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderClasses(students) {
  const classNames = [...new Set(students.map((student) => student.className))].sort();
  return `<div class="callout"><p class="callout-copy">This invite code is only a visual placeholder in the prototype. Students are added here as demo profiles and switch users from the top-right menu.</p><span class="code-chip">SCHOLA11</span></div><div class="class-grid">${classNames.map((className) => {
    const members = rankedStudents(students.filter((student) => student.className === className));
    return `<article class="surface-card class-card"><div class="class-card-head"><div><h3>${escapeHtml(className)}</h3><span class="small">${members.length} students · ranked by ELO</span></div><span class="class-chip">CLASS</span></div><div class="class-list">${members.map((student) => `<div class="player-block"><span class="avatar">${escapeHtml(student.name.slice(0, 1))}</span><div class="player-copy"><strong>${escapeHtml(student.name)}</strong><span class="small">#${studentRank(members, student.id)} in class</span></div><span class="class-rating">${getStreamRating(student.id)} <small>ELO</small></span></div>`).join("")}</div></article>`;
  }).join("") || emptyState("No students yet", "Add a demo student to preview the class list.")}</div>`;
}

function openAddStudent(teacher) {
  openModal(`<div class="modal-header"><div><p class="eyebrow">DEMO CLASSROOM</p><h2 id="modalTitle">Add a student profile</h2></div><button class="button button-quiet" data-close-modal aria-label="Close dialog">✕</button></div><p class="modal-description">This adds a local demo profile so you can preview the student experience. Real invitations will need a backend.</p><div class="field"><label for="studentName">Student name</label><input id="studentName" placeholder="For example, Aigerim" autocomplete="off"></div><div class="field"><label for="studentClass">Class</label><select id="studentClass"><option>Grade 11A</option><option>Grade 11B</option></select></div><div class="modal-footer"><span class="small">Added to ${escapeHtml(teacher.stream)}</span><button class="button button-primary" id="saveStudent">Add profile</button></div>`);
  document.querySelector("[data-close-modal]").addEventListener("click", closeModal);
  document.getElementById("saveStudent").addEventListener("click", () => {
    const name = document.getElementById("studentName").value.trim();
    if (!name) return showToast("Enter a student name first.");
    state.users.push({ id: makeId(), name, role: "student", className: document.getElementById("studentClass").value, stream: teacher.stream });
    saveState();
    closeModal();
    render();
    showToast("Student profile added.");
  });
}

function openSetEditor(setId = null) {
  const existing = setId ? findSet(setId) : null;
  const questions = existing ? existing.questions.map((question) => ({ text: question[0], options: [...question[1]], correct: question[2], explanation: question[3] || "" })) : [];
  const defaultClasses = existing ? existing.classNames.join(", ") : "Grade 11A, Grade 11B";
  const formTitle = existing ? "Edit chapter" : "Create a chapter";

  openModal(`<div class="modal-header"><div><p class="eyebrow">TEACHER TOOL</p><h2 id="modalTitle">${formTitle}</h2></div><button class="button button-quiet" data-close-modal aria-label="Close dialog">✕</button></div><p class="modal-description">Write questions manually for now. A chapter needs at least 15 questions before it can be published for ranked matches.</p><div class="form-grid"><div class="field"><label for="setTitle">Chapter title</label><input id="setTitle" value="${escapeHtml(existing?.title || "")}" placeholder="For example, World War I"></div><div class="field"><label for="setSubject">Subject</label><input id="setSubject" value="${escapeHtml(existing?.subject || "")}" placeholder="History"></div><div class="field"><label for="setClasses">Available to classes</label><input id="setClasses" value="${escapeHtml(defaultClasses)}" placeholder="Grade 11A, Grade 11B"></div></div><div class="question-editor"><h3>Questions <span class="small" id="questionCount"></span></h3><div class="question-list" id="questionList"></div><h3>Add a question</h3><div class="field"><label for="questionText">Question</label><input id="questionText" placeholder="Type a clear question"></div><div class="form-grid"><div class="field"><label for="option0">Option A</label><input id="option0"></div><div class="field"><label for="option1">Option B</label><input id="option1"></div><div class="field"><label for="option2">Option C</label><input id="option2"></div><div class="field"><label for="option3">Option D</label><input id="option3"></div><div class="field"><label for="correctOption">Correct option</label><select id="correctOption"><option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option></select></div><div class="field"><label for="explanation">Explanation (optional)</label><input id="explanation" placeholder="Why is this the right answer?"></div></div><button class="button button-secondary" id="addQuestion">＋ Add question</button></div><div class="modal-footer"><span class="small" id="publishHint"></span><div class="modal-actions"><button class="button button-outline" id="saveDraft">Save draft</button><button class="button button-primary" id="publishSet">${existing?.published ? "Save and publish" : "Publish chapter"}</button></div></div>`);

  document.querySelector("[data-close-modal]").addEventListener("click", closeModal);
  const drawQuestions = () => {
    document.getElementById("questionCount").textContent = `· ${questions.length}`;
    document.getElementById("publishHint").textContent = questions.length >= 15 ? "Ready to publish" : `${15 - questions.length} more needed to publish`;
    document.getElementById("questionList").innerHTML = questions.map((question, index) => `<div class="question-row"><div class="question-row-copy"><strong>${index + 1}. ${escapeHtml(question.text)}</strong><span>Correct: ${ANSWER_LABELS[question.correct]} · ${escapeHtml(question.options[question.correct])}</span></div><button class="button button-quiet" data-remove-question="${index}" aria-label="Remove question ${index + 1}">Remove</button></div>`).join("") || `<p class="small">Your questions will appear here as you add them.</p>`;
    document.querySelectorAll("[data-remove-question]").forEach((button) => button.addEventListener("click", () => {
      questions.splice(Number(button.dataset.removeQuestion), 1);
      drawQuestions();
    }));
  };
  drawQuestions();

  document.getElementById("addQuestion").addEventListener("click", () => {
    const text = document.getElementById("questionText").value.trim();
    const options = [0, 1, 2, 3].map((index) => document.getElementById(`option${index}`).value.trim());
    if (!text || options.some((option) => !option)) return showToast("Add the question and all four answer options.");
    questions.push({ text, options, correct: Number(document.getElementById("correctOption").value), explanation: document.getElementById("explanation").value.trim() });
    ["questionText", "option0", "option1", "option2", "option3", "explanation"].forEach((id) => { document.getElementById(id).value = ""; });
    drawQuestions();
    document.getElementById("questionText").focus();
  });

  const saveSet = (published) => {
    const title = document.getElementById("setTitle").value.trim();
    if (!title) return showToast("Add a chapter title first.");
    if (published && questions.length < 15) return showToast("Add at least 15 questions before publishing.");
    const classes = document.getElementById("setClasses").value.split(",").map((name) => name.trim()).filter(Boolean);
    if (!classes.length) return showToast("Choose at least one class for this chapter.");
    const record = {
      id: existing?.id || makeId(),
      title,
      subject: document.getElementById("setSubject").value.trim() || "General",
      published,
      stream: currentUser().stream,
      classNames: classes,
      questions: questions.map((question) => [question.text, question.options, question.correct, question.explanation]),
    };
    if (existing) Object.assign(existing, record);
    else state.sets.unshift(record);
    saveState();
    closeModal();
    render();
    showToast(published ? "Chapter published." : "Draft saved.");
  };
  document.getElementById("saveDraft").addEventListener("click", () => saveSet(false));
  document.getElementById("publishSet").addEventListener("click", () => saveSet(true));
}

function bindTabs() {
  const buttons = [...document.querySelectorAll("[data-tab]")];
  buttons.forEach((button) => button.addEventListener("click", () => {
    buttons.forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${button.dataset.tab}`));
  }));
}

function studentQuestionSets(student) {
  return state.sets.filter((questionSet) => questionSet.published && questionSet.stream === student.stream && questionSet.classNames.includes(student.className));
}

function matchesForStudent(student, status) {
  return state.battles.filter((battle) => battle.participants.includes(student.id) && (!status || battle.status === status));
}

function rankedMatchCount(studentId, setId) {
  return state.battles.filter((battle) => battle.setId === setId && battle.participants.includes(studentId) && (battle.acceptedAt || ["active", "done", "forfeit", "void"].includes(battle.status))).length;
}

function getStreamRating(studentId) {
  const student = state.users.find((user) => user.id === studentId);
  return student?.streamRatings?.[student.stream] ?? 1000;
}

function rankedStudents(students) {
  return [...students].sort((first, second) => getStreamRating(second.id) - getStreamRating(first.id) || first.name.localeCompare(second.name));
}

function studentRank(students, studentId) {
  const ordered = rankedStudents(students);
  const index = ordered.findIndex((student) => student.id === studentId);
  if (index < 0) return 0;
  const rating = getStreamRating(studentId);
  return ordered.findIndex((student) => getStreamRating(student.id) === rating) + 1;
}

function renderLeaderboard(title, description, students, activeStudent, showClass = false) {
  if (!students.length) return `<section class="leaderboard-section"><div class="section-heading"><div><h2>${title}</h2><p>${description}</p></div></div>${emptyState("No students yet", "Rankings will appear when students join this group.")}</section>`;

  let previousRating = null;
  let previousRank = 0;
  const rows = rankedStudents(students).map((student, index) => {
    const rating = getStreamRating(student.id);
    const rank = rating === previousRating ? previousRank : index + 1;
    previousRating = rating;
    previousRank = rank;
    const current = student.id === activeStudent.id;
    return `<tr class="${current ? "leaderboard-current" : ""}"><td><span class="rank-number ${rank <= 3 ? "rank-top" : ""}">${rank}</span></td><td><div class="leaderboard-player"><span class="avatar ${rank === 1 ? "gold" : ""}">${escapeHtml(student.name.slice(0, 1))}</span><strong>${escapeHtml(student.name)}</strong>${current ? '<span class="you-tag">You</span>' : ""}</div></td>${showClass ? `<td><span class="class-label">${escapeHtml(student.className)}</span></td>` : ""}<td><strong class="leaderboard-rating">${rating}</strong><span class="small"> ELO</span></td></tr>`;
  }).join("");
  const classHeader = showClass ? "<th>Class</th>" : "";
  return `<section class="leaderboard-section"><div class="section-heading"><div><h2>${title}</h2><p>${description}</p></div><span class="leaderboard-count">${students.length} ${students.length === 1 ? "student" : "students"}</span></div><div class="table-wrap leaderboard-wrap"><table class="leaderboard-table"><thead><tr><th>Rank</th><th>Student</th>${classHeader}<th>Rating</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderStudentLeaderboards(student) {
  const streamStudents = state.users.filter((user) => user.role === "student" && user.stream === student.stream);
  const classStudents = streamStudents.filter((user) => user.className === student.className);
  const streamRank = studentRank(streamStudents, student.id);
  const classRank = studentRank(classStudents, student.id);
  return `<div class="leaderboard-intro"><div><p class="eyebrow">YOUR CLASSROOM COMMUNITY</p><h2>${escapeHtml(student.className)} <span>·</span> ${escapeHtml(student.stream)}</h2><p>See how your class is doing and compare your rating with everyone in your teacher’s stream. Duels can match you with any eligible student in the stream.</p></div><div class="rank-summary"><div><span>Your class rank</span><strong>#${classRank || "—"}</strong></div><div><span>Stream rank</span><strong>#${streamRank || "—"}</strong></div></div></div>${renderLeaderboard("Your class", `Students in ${escapeHtml(student.className)} · ratings use the shared stream ELO.`, classStudents, student)}${renderLeaderboard("Teacher’s stream", `All classes in ${escapeHtml(student.stream)} · opponents may come from another class.`, streamStudents, student, true)}`;
}

function studentPerformance(student) {
  const completed = matchesForStudent(student).filter((battle) => ["done", "forfeit", "void"].includes(battle.status));
  const scoredMatches = completed.filter((battle) => battle.attempts[student.id].submitted);
  const wins = completed.filter((battle) => battle.winner === student.id).length;
  const correct = scoredMatches.reduce((sum, battle) => sum + calculateScore(battle, student.id), 0);
  const total = scoredMatches.reduce((sum, battle) => sum + battle.questions.length, 0);
  return { completed, wins, correct, total };
}

function renderStudent(student) {
  const sets = studentQuestionSets(student);
  const pending = matchesForStudent(student).filter((battle) => ["pending", "active"].includes(battle.status));
  const performance = studentPerformance(student);
  app.innerHTML = `${pageHeading(`STUDENT · ${escapeHtml(student.className)}`, `Welcome back, ${escapeHtml(student.name)}.`, "Pick a chapter, challenge someone from your stream, and use every match as a chance to learn.")}
    <section class="hero-banner" aria-label="Student overview"><div class="hero-copy"><p class="eyebrow">YOUR LEARNING ARENA</p><h2>Small rounds. Stronger recall.</h2><p>Play a few ranked matches, then revisit the full chapter at your own pace.</p></div><div class="hero-side"><span class="hero-side-label">Ranked matches played</span><strong class="hero-side-number">${performance.completed.length}</strong><span class="hero-side-note">Each chapter set has its own three-match limit.</span></div></section>
    <div class="stats-grid student-stats">${statCard("⚔", performance.completed.length, "Matches resolved")}${statCard("✦", performance.wins, "Wins")}${statCard("✓", `${performance.correct} / ${performance.total}`, "Correct answers")}${statCard("◈", `${getStreamRating(student.id)} ELO`, "Stream rating")}</div>
    <nav class="tab-bar" aria-label="Student sections"><button class="tab-button active" data-tab="play">Play</button><button class="tab-button" data-tab="challenges">Challenges <span class="tab-count">${pending.length}</span></button><button class="tab-button" data-tab="leaderboard">Class & rankings</button><button class="tab-button" data-tab="practice">Practice</button><button class="tab-button" data-tab="history">Match history</button></nav>
    <section class="tab-panel active" id="panel-play"><div class="section-heading"><div><h2>Choose a chapter</h2><p>Face any student in ${escapeHtml(student.stream)} whose class has access to the chapter.</p></div></div><div class="card-grid">${sets.map((questionSet) => renderStudentSet(questionSet, student)).join("") || emptyState("No chapters available yet", "Your teacher’s published chapters will show up here.")}</div><div class="section-heading"><div><h2>Your active matches</h2><p>Finish your answers now or come back later.</p></div></div>${renderBattleList(pending, student)}</section>
    <section class="tab-panel" id="panel-challenges"><div class="section-heading"><div><h2>Challenges</h2><p>Accept an incoming match or finish one you already started.</p></div></div>${renderBattleList(pending, student)}</section>
    <section class="tab-panel" id="panel-leaderboard">${renderStudentLeaderboards(student)}</section>
    <section class="tab-panel" id="panel-practice"><div class="section-heading"><div><h2>Practice without pressure</h2><p>Review the entire chapter. Practice never changes ranked results.</p></div></div><div class="card-grid">${sets.map((questionSet) => `<article class="surface-card set-card"><div class="set-card-top"><span class="subject-tag">${escapeHtml(questionSet.subject)}</span><span class="state-tag">No rating</span></div><span class="set-icon" aria-hidden="true">↻</span><h3>${escapeHtml(questionSet.title)}</h3><p class="set-meta">${questionSet.questions.length} questions · self-paced</p><div class="set-card-footer"><span class="small">Review the full chapter</span><button class="button button-secondary" data-practice-set="${escapeHtml(questionSet.id)}">Start practice</button></div></article>`).join("") || emptyState("Nothing to review yet", "Published chapters will appear here.")}</div></section>
    <section class="tab-panel" id="panel-history"><div class="section-heading"><div><h2>Match history</h2><p>See your results and revisit the explanations.</p></div></div>${renderBattleList(matchesForStudent(student).filter((battle) => ["done", "forfeit", "void"].includes(battle.status)), student)}</section>`;

  bindTabs();
  document.querySelectorAll("[data-challenge-set]").forEach((button) => button.addEventListener("click", () => createBattle(student, button.dataset.challengeSet)));
  document.querySelectorAll("[data-practice-set]").forEach((button) => button.addEventListener("click", () => startPractice(findSet(button.dataset.practiceSet))));
  bindBattleList(student);
}

function renderStudentSet(questionSet, student) {
  const played = rankedMatchCount(student.id, questionSet.id);
  const left = Math.max(0, 3 - played);
  const hasPending = state.battles.some((battle) => battle.setId === questionSet.id && battle.status === "pending" && battle.participants.includes(student.id));
  return `<article class="surface-card set-card"><div class="set-card-top"><span class="subject-tag">${escapeHtml(questionSet.subject)}</span><span class="state-tag">${left} ${left === 1 ? "match" : "matches"} left</span></div><span class="set-icon" aria-hidden="true">✳</span><h3>${escapeHtml(questionSet.title)}</h3><p class="set-meta">${questionSet.questions.length} questions · ${escapeHtml(questionSet.classNames.join(" · "))}</p><div class="progress-track" style="margin-top:14px"><div class="progress-fill" style="width:${Math.min(100, played / 3 * 100)}%"></div></div><div class="set-card-footer"><span class="small">Stream rating · ${getStreamRating(student.id)} ELO</span><button class="button button-primary" data-challenge-set="${escapeHtml(questionSet.id)}" ${left === 0 || hasPending ? "disabled" : ""}>${hasPending ? "Invite pending" : "Find an opponent"} <span aria-hidden="true">→</span></button></div></article>`;
}

function renderBattleList(battles, student) {
  if (!battles.length) return emptyState("No matches here yet", "Choose a chapter and find an opponent to start a duel.");
  return battles.map((battle) => {
    const set = findSet(battle.setId);
    const otherId = battle.participants.find((id) => id !== student.id);
    const opponent = state.users.find((person) => person.id === otherId);
    const mine = battle.attempts[student.id];
    const resolved = ["done", "forfeit", "void"].includes(battle.status);
    const status = battle.status === "done" ? "Completed"
      : battle.status === "forfeit" ? battle.winner === student.id ? "Won by forfeit" : "Lost by forfeit"
        : battle.status === "void" ? "No contest · no submissions"
          : battle.status === "pending" ? `Invitation · expires in ${formatTimeRemaining(battle.createdAt + CHALLENGE_TTL_MS)}`
            : `${mine.submitted ? "Submitted · " : "Your turn · "}due in ${formatTimeRemaining(battle.deadlineAt)}`;
    const action = resolved
      ? `<button class="button button-outline" data-open-result="${escapeHtml(battle.id)}">View result</button>`
      : battle.status === "pending" && battle.pendingFor === student.id
        ? `<button class="button button-secondary" data-accept-battle="${escapeHtml(battle.id)}">Accept challenge</button>`
        : battle.status === "pending"
          ? `<button class="button button-outline" data-cancel-challenge="${escapeHtml(battle.id)}">Cancel invite</button>`
          : `<button class="button ${mine.submitted ? "button-outline" : "button-primary"}" data-open-battle="${escapeHtml(battle.id)}" ${mine.submitted ? "disabled" : ""}>${mine.submitted ? "Waiting" : "Continue"}</button>`;
    return `<article class="surface-card challenge-card"><div class="player-block"><span class="avatar ${resolved ? "gold" : ""}">${escapeHtml(opponent?.name.slice(0, 1) || "?")}</span><div class="player-copy"><strong>${escapeHtml(opponent?.name || "Opponent")} · ${escapeHtml(set?.title || "Chapter")}</strong><span class="small">${escapeHtml(opponent?.className || "")} · ${battle.questions.length} questions · ${status}</span></div></div>${action}</article>`;
  }).join("");
}

function formatTimeRemaining(deadlineAt) {
  const remaining = Math.max(0, deadlineAt - Date.now());
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const minutes = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function bindBattleList(student) {
  document.querySelectorAll("[data-accept-battle]").forEach((button) => button.addEventListener("click", () => acceptBattle(button.dataset.acceptBattle, student)));
  document.querySelectorAll("[data-cancel-challenge]").forEach((button) => button.addEventListener("click", () => cancelChallenge(button.dataset.cancelChallenge, student)));
  document.querySelectorAll("[data-open-battle]").forEach((button) => button.addEventListener("click", () => openBattle(button.dataset.openBattle, student)));
  document.querySelectorAll("[data-open-result]").forEach((button) => button.addEventListener("click", () => showBattleResult(state.battles.find((battle) => battle.id === button.dataset.openResult), student)));
}

function createBattle(student, setId) {
  if (processBattleDeadlines()) render();
  const set = findSet(setId);
  if (!set || rankedMatchCount(student.id, setId) >= 3) return showToast("You have used all three ranked matches for this chapter.");
  const existingInvite = state.battles.some((battle) => battle.setId === setId && battle.status === "pending" && battle.participants.includes(student.id));
  if (existingInvite) return showToast("You already have an open invitation for this chapter.");
  const eligibleOpponents = state.users.filter((person) => person.role === "student" && person.id !== student.id && person.stream === student.stream && set.classNames.includes(person.className) && rankedMatchCount(person.id, setId) < 3 && !state.battles.some((battle) => battle.setId === setId && battle.status === "pending" && battle.participants.includes(person.id)));
  if (!eligibleOpponents.length) return showToast("No eligible opponent is available right now.");

  const opponent = eligibleOpponents[Math.floor(Math.random() * eligibleOpponents.length)];
  const matchSize = Math.min(set.questions.length, Math.max(5, Math.floor(set.questions.length / 3)));
  const selectedQuestions = sampleWithoutReplacement(set.questions, matchSize).map((question) => ({ text: question[0], options: [...question[1]], correct: question[2], explanation: question[3] || "" }));
  const firstOptionOrders = createOptionOrders(selectedQuestions);
  const secondOptionOrders = createOptionOrders(selectedQuestions, firstOptionOrders);
  const answers = (optionOrders) => ({ answers: Array(selectedQuestions.length).fill(null), submitted: false, optionOrders });
  const battle = {
    id: makeId(), setId, participants: [student.id, opponent.id], pendingFor: opponent.id,
    status: "pending", questions: selectedQuestions,
    attempts: { [student.id]: answers(firstOptionOrders), [opponent.id]: answers(secondOptionOrders) },
    createdAt: Date.now(), winner: null,
  };
  state.battles.unshift(battle);
  saveState();
  render();
  showToast(`Challenge sent to ${opponent.name}.`);
}

function sampleWithoutReplacement(items, count) {
  const pool = [...items];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, count);
}

function createOptionOrders(questions, differentFrom = []) {
  let previousCorrectSlot = -1;
  return questions.map((question, questionIndex) => {
    const optionIndices = question.options.map((_, index) => index);
    const forbiddenSlots = new Set();
    const otherCorrectSlot = differentFrom[questionIndex]?.indexOf(question.correct) ?? -1;
    if (otherCorrectSlot >= 0) forbiddenSlots.add(otherCorrectSlot);
    if (previousCorrectSlot >= 0) forbiddenSlots.add(previousCorrectSlot);
    const availableSlots = optionIndices.filter((index) => !forbiddenSlots.has(index));
    const correctSlot = availableSlots[Math.floor(Math.random() * availableSlots.length)];
    const distractors = sampleWithoutReplacement(optionIndices.filter((index) => index !== question.correct), optionIndices.length - 1);
    let distractorIndex = 0;
    const order = optionIndices.map((slot) => slot === correctSlot ? question.correct : distractors[distractorIndex++]);
    previousCorrectSlot = correctSlot;
    return order;
  });
}

function acceptBattle(battleId, student) {
  if (processBattleDeadlines()) render();
  const battle = state.battles.find((item) => item.id === battleId);
  if (!battle || battle.status !== "pending" || battle.pendingFor !== student.id) return showToast("This invitation has expired or is no longer available.");
  const hasRoom = battle.participants.every((userId) => rankedMatchCount(userId, battle.setId) < 3);
  if (!hasRoom) {
    battle.status = "cancelled";
    battle.pendingFor = null;
    saveState();
    render();
    return showToast("A player has already used all three matches for this chapter.");
  }
  battle.pendingFor = null;
  battle.status = "active";
  battle.acceptedAt = Date.now();
  battle.deadlineAt = battle.acceptedAt + MATCH_TTL_MS;
  saveState();
  openBattle(battleId, student);
}

function cancelChallenge(battleId, student) {
  if (processBattleDeadlines()) render();
  const battle = state.battles.find((item) => item.id === battleId);
  if (!battle || battle.status !== "pending" || battle.pendingFor === student.id) return;
  battle.status = "cancelled";
  battle.pendingFor = null;
  saveState();
  render();
  showToast("Invitation cancelled. No match was used.");
}

function openBattle(battleId, student) {
  if (processBattleDeadlines()) render();
  const battle = state.battles.find((item) => item.id === battleId);
  if (!battle || !battle.attempts[student.id]) return showToast("This match belongs to another profile.");
  if (["done", "forfeit", "void"].includes(battle.status)) return showBattleResult(battle, student);
  if (battle.pendingFor === student.id) return showToast("Accept the challenge before playing.");
  const attempt = battle.attempts[student.id];
  if (attempt.submitted) return showToast("Your answers are saved. Waiting for your opponent.");

  const set = findSet(battle.setId);
  activeBattleId = battleId;
  const playerQuestions = battle.questions.map((question, index) => {
    const order = attempt.optionOrders?.[index] || question.options.map((_, optionIndex) => optionIndex);
    return { ...question, options: order.map((optionIndex) => question.options[optionIndex]), correct: order.indexOf(question.correct) };
  });
  openQuiz({
    title: set?.title || "Ranked match",
    questions: playerQuestions,
    initialAnswers: attempt.answers,
    isPractice: false,
    deadlineAt: battle.deadlineAt,
    onFinish: (answers) => {
      if (Date.now() >= battle.deadlineAt) {
        processBattleDeadlines();
        closeModal();
        render();
        return showBattleResult(battle, student);
      }
      attempt.answers = answers;
      attempt.submitted = true;
      const otherId = battle.participants.find((id) => id !== student.id);
      if (battle.attempts[otherId].submitted) {
        battle.status = "done";
        const playerScore = calculateScore(battle, student.id);
        const opponentScore = calculateScore(battle, otherId);
        battle.winner = playerScore === opponentScore ? null : playerScore > opponentScore ? student.id : otherId;
        updateStreamRatings(battle);
      }
      saveState();
      closeModal();
      render();
      if (battle.status === "done") showBattleResult(battle, student);
      else showToast("Answers saved. The result will appear when your opponent finishes.");
    },
  });
}

function calculateScore(battle, userId) {
  const attempt = battle.attempts[userId];
  return attempt.answers.reduce((score, answer, index) => {
    if (answer === null) return score;
    const optionOrder = attempt.optionOrders?.[index] || battle.questions[index].options.map((_, optionIndex) => optionIndex);
    return score + (optionOrder[answer] === battle.questions[index].correct ? 1 : 0);
  }, 0);
}

function updateStreamRatings(battle) {
  if (battle.ratingApplied) return;
  const [firstId, secondId] = battle.participants;
  const first = state.users.find((user) => user.id === firstId);
  const second = state.users.find((user) => user.id === secondId);
  if (!first || !second || first.stream !== second.stream) return;
  first.streamRatings ||= {};
  second.streamRatings ||= {};

  const firstRating = getStreamRating(firstId);
  const secondRating = getStreamRating(secondId);
  const firstScore = calculateScore(battle, firstId);
  const secondScore = calculateScore(battle, secondId);
  const actual = firstScore === secondScore ? 0.5 : firstScore > secondScore ? 1 : 0;
  const expected = 1 / (1 + 10 ** ((secondRating - firstRating) / 400));
  const firstChange = Math.round(ELO_K_FACTOR * (actual - expected));

  battle.ratingBefore = { [firstId]: firstRating, [secondId]: secondRating };
  battle.ratingChanges = { [firstId]: firstChange, [secondId]: -firstChange };
  first.streamRatings[first.stream] = firstRating + firstChange;
  second.streamRatings[second.stream] = secondRating - firstChange;
  battle.ratingApplied = true;
}

function formatRatingChange(change) {
  return change > 0 ? `+${change}` : String(change);
}

function showOpenBattleDeadlineResult() {
  if (!activeBattleId) return;
  const battle = state.battles.find((item) => item.id === activeBattleId);
  if (!battle || !["forfeit", "void", "done"].includes(battle.status)) return;
  const student = currentUser();
  closeModal();
  render();
  if (student?.role === "student" && battle.participants.includes(student.id)) showBattleResult(battle, student);
}

function showBattleResult(battle, student) {
  if (!battle || !["done", "forfeit", "void"].includes(battle.status)) return;
  const opponentId = battle.participants.find((id) => id !== student.id);
  const opponent = state.users.find((person) => person.id === opponentId);
  const ownAttempt = battle.attempts[student.id];
  const opponentAttempt = battle.attempts[opponentId];
  const ownScore = ownAttempt.submitted ? `${calculateScore(battle, student.id)} / ${battle.questions.length}` : "No submission";
  const opponentScore = opponentAttempt.submitted ? `${calculateScore(battle, opponentId)} / ${battle.questions.length}` : "No submission";
  const headline = battle.status === "void" ? "No contest. Neither player submitted."
    : battle.status === "forfeit" ? battle.winner === student.id ? "You won by forfeit." : "You forfeited this match."
      : battle.winner === student.id ? "A well-earned win!" : battle.winner === opponentId ? "Your opponent won this round." : "A draw. Nice match.";
  const ratingSummary = battle.ratingApplied
    ? `<div class="rating-summary"><strong>Stream ELO</strong><span>${escapeHtml(student.name)}: ${battle.ratingBefore[student.id]} → ${battle.ratingBefore[student.id] + battle.ratingChanges[student.id]} (${formatRatingChange(battle.ratingChanges[student.id])})</span><span>${escapeHtml(opponent?.name || "Opponent")}: ${battle.ratingBefore[opponentId]} → ${battle.ratingBefore[opponentId] + battle.ratingChanges[opponentId]} (${formatRatingChange(battle.ratingChanges[opponentId])})</span></div>`
    : battle.status === "done" ? ""
      : `<div class="rating-summary"><strong>Stream ELO unchanged</strong><span>Forfeits and no-contests do not affect ratings in this prototype.</span></div>`;
  const review = ownAttempt.submitted ? battle.questions.map((question, index) => {
    const order = ownAttempt.optionOrders?.[index] || question.options.map((_, optionIndex) => optionIndex);
    const displayedOptions = order.map((optionIndex) => question.options[optionIndex]);
    const correctIndex = order.indexOf(question.correct);
    const correct = ownAttempt.answers[index] === correctIndex;
    return `<div class="answer-review"><strong class="${correct ? "is-correct" : "is-incorrect"}">${correct ? "✓" : "×"} ${index + 1}. ${escapeHtml(question.text)}</strong><span>Correct answer: ${ANSWER_LABELS[correctIndex]} · ${escapeHtml(displayedOptions[correctIndex])}${question.explanation ? ` — ${escapeHtml(question.explanation)}` : ""}</span></div>`;
  }).join("") : `<p class="small">No answers were submitted from your profile before the deadline.</p>`;
  const resultLabel = battle.status === "void" ? "DEADLINE PASSED" : battle.status === "forfeit" ? "MATCH FORFEIT" : "MATCH COMPLETE";
  openModal(`<div class="modal-header"><div><p class="eyebrow">${resultLabel}</p><h2 id="modalTitle">${headline}</h2></div><button class="button button-quiet" data-close-modal aria-label="Close dialog">✕</button></div><div class="result-summary"><div class="result-stat"><strong>${ownScore}</strong><span>${escapeHtml(student.name)}${ownAttempt.submitted ? " · correct" : ""}</span></div><div class="result-stat"><strong>${opponentScore}</strong><span>${escapeHtml(opponent?.name || "Opponent")}${opponentAttempt.submitted ? " · correct" : ""}</span></div></div>${ratingSummary}${review}<div class="modal-footer"><span class="small">Review what you answered, then practise the full chapter.</span><button class="button button-primary" data-close-modal>Done</button></div>`);
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
}

function startPractice(set) {
  if (!set) return;
  const sourceQuestions = set.questions.map((question) => ({ text: question[0], options: [...question[1]], correct: question[2], explanation: question[3] || "" }));
  const optionOrders = createOptionOrders(sourceQuestions);
  const questions = sourceQuestions.map((question, index) => ({
    ...question,
    options: optionOrders[index].map((optionIndex) => question.options[optionIndex]),
    correct: optionOrders[index].indexOf(question.correct),
  }));
  openQuiz({ title: set.title, questions, initialAnswers: Array(questions.length).fill(null), isPractice: true, onFinish: (answers) => {
    const correct = answers.filter((answer, index) => answer === questions[index].correct).length;
    openModal(`<div class="modal-header"><div><p class="eyebrow">PRACTICE COMPLETE</p><h2 id="modalTitle">Nice work. Keep the momentum.</h2></div><button class="button button-quiet" data-close-modal aria-label="Close dialog">✕</button></div><div class="result-score">${correct}<span> / ${questions.length} correct</span></div><p class="modal-description">This practice session does not affect ranked results. Try the questions you missed again later.</p><div class="modal-footer"><span class="small">Chapter · ${escapeHtml(set.title)}</span><button class="button button-primary" data-close-modal>Done</button></div>`);
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  } });
}

function openQuiz({ title, questions, initialAnswers, isPractice, deadlineAt = null, onFinish }) {
  const answers = [...initialAnswers];
  let index = Math.max(0, answers.findIndex((answer) => answer === null));
  const paint = () => {
    const question = questions[index];
    modal.innerHTML = `<div class="modal-header"><div><p class="eyebrow">${isPractice ? "PRACTICE MODE" : "ASYNC DUEL"}</p><h2 id="modalTitle">${escapeHtml(title)}</h2></div><button class="button button-quiet" id="leaveQuiz" aria-label="Close quiz">✕</button></div><div class="quiz-progress-head"><span>Question ${index + 1} of ${questions.length}</span><span id="matchDeadline" data-deadline="${deadlineAt || ""}">${isPractice ? "No rating" : deadlineAt ? `Due in ${formatTimeRemaining(deadlineAt)}` : "Ranked match"}</span></div><div class="progress-track" style="margin-top:9px"><div class="progress-fill" style="width:${(index + 1) / questions.length * 100}%"></div></div><h3 class="quiz-question">${escapeHtml(question.text)}</h3><div class="answer-list">${question.options.map((option, optionIndex) => `<button class="answer-option ${answers[index] === optionIndex ? "selected" : ""}" data-answer="${optionIndex}"><span class="answer-letter">${ANSWER_LABELS[optionIndex]}</span><span>${escapeHtml(option)}</span></button>`).join("")}</div><div class="quiz-footer"><button class="button button-outline" id="previousQuestion" ${index === 0 ? "disabled" : ""}>← Back</button><button class="button button-primary" id="nextQuestion">${index === questions.length - 1 ? isPractice ? "Finish practice" : "Submit answers" : "Next question →"}</button></div>`;
    document.getElementById("leaveQuiz").addEventListener("click", closeModal);
    document.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => {
      answers[index] = Number(button.dataset.answer);
      paint();
    }));
    document.getElementById("previousQuestion").addEventListener("click", () => {
      if (index > 0) { index -= 1; paint(); }
    });
    document.getElementById("nextQuestion").addEventListener("click", () => {
      if (answers[index] === null) return showToast("Choose an answer to continue.");
      if (index < questions.length - 1) { index += 1; paint(); return; }
      if (answers.some((answer) => answer === null)) {
        index = answers.findIndex((answer) => answer === null);
        paint();
        return showToast("Answer every question before submitting.");
      }
      onFinish(answers);
    });
  };
  openModal("");
  paint();
}

window.scholaShowToast = showToast;
window.scholaOpenModal = openModal;
window.scholaCloseModal = closeModal;
window.scholaOpenQuiz = openQuiz;

window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) {
    state = loadState();
    render();
  }
});

window.setInterval(() => {
  if (supabaseClient && !supabaseAuthReady) return;
  if (supabaseSession) {
    window.ScholaLiveApp?.refresh();
    return;
  }
  const processed = processBattleDeadlines();
  if (processed) showOpenBattleDeadlineResult();
  const deadlineLabel = document.getElementById("matchDeadline");
  if (deadlineLabel?.dataset.deadline) deadlineLabel.textContent = `Due in ${formatTimeRemaining(Number(deadlineLabel.dataset.deadline))}`;
  if (processed || state.battles.some((battle) => ["pending", "active"].includes(battle.status))) render();
}, 60_000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (supabaseClient && !supabaseAuthReady) return;
    if (supabaseSession) {
      window.ScholaLiveApp?.refresh();
      return;
    }
    if (processBattleDeadlines()) {
      showOpenBattleDeadlineResult();
      render();
    }
    const deadlineLabel = document.getElementById("matchDeadline");
    if (deadlineLabel?.dataset.deadline) deadlineLabel.textContent = `Due in ${formatTimeRemaining(Number(deadlineLabel.dataset.deadline))}`;
  }
});

render();
