(() => {
  const client = window.scholaSupabase;
  const root = document.getElementById("app");
  const model = { userId: null, role: null, profile: null, loaded: false, loading: false, error: null, activeTab: null };
  let context = null;
  let loadGeneration = 0;

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const toast = (message) => window.scholaShowToast?.(message);
  const openModal = (html) => window.scholaOpenModal?.(html);
  const closeModal = () => window.scholaCloseModal?.();
  const errorMessage = (error, fallback) => window.scholaUserErrorMessage?.(error, fallback) || fallback;
  const isCurrentUser = (userId) => userId === model.userId && userId === context?.session?.user?.id;

  const draftPrefix = "schola-match-draft:";
  function matchDraft(userId, matchId, fingerprint, deadline, answers) {
    const key = `${draftPrefix}${userId}:${matchId}`;
    try {
      if (answers === null) return localStorage.removeItem(key);
      // Expired drafts are removed without retaining account or question content.
      for (const storedKey of Object.keys(localStorage).filter((item) => item.startsWith(draftPrefix))) {
        try {
          const stored = JSON.parse(localStorage.getItem(storedKey));
          if (!Number.isFinite(stored?.deadline) || stored.deadline <= Date.now()) localStorage.removeItem(storedKey);
        } catch { localStorage.removeItem(storedKey); }
      }
      if (answers !== undefined) {
        if (deadline > Date.now()) localStorage.setItem(key, JSON.stringify({ fingerprint, deadline, answers }));
        return;
      }
      const draft = JSON.parse(localStorage.getItem(key));
      return draft?.fingerprint === fingerprint && draft.deadline === deadline && deadline > Date.now() && Array.isArray(draft.answers)
        ? draft.answers : [];
    } catch { return []; }
  }

  async function rows(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function one(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  function header(eyebrow, title, description, action = "") {
    return `<div class="page-heading"><div><p class="eyebrow">${escape(eyebrow)}</p><h1>${escape(title)}</h1><p class="lede">${escape(description)}</p></div>${action}</div>`;
  }

  function loadingView() {
    root.innerHTML = `${header("YOUR CLASSROOM", "Loading your workspace", "Loading your classes and chapters.")}<div class="empty-state"><strong>One moment…</strong>Your account is being prepared.</div>`;
  }

  function errorView(error) {
    root.innerHTML = `${header("CONNECTION ISSUE", "We couldn't load your workspace", "Your account is still safe. Try loading the latest data again.")}<div class="empty-state"><strong>${escape(errorMessage(error, "We couldn't load your classes. Please try again."))}</strong><button class="button button-primary" id="liveRetry" type="button" style="margin-top:16px">Try again</button></div>`;
    root.querySelector("#liveRetry").addEventListener("click", () => refresh());
  }

  async function loadTeacherData(userId) {
    const streams = await rows(client.from("teacher_streams")
      .select("id, name, created_at").eq("owner_user_id", userId).order("created_at", { ascending: true }));
    if (!streams.length) return { streams, classes: [], chapters: [], assignments: [], invites: [], members: [], people: [], matches: [], ratings: [], chapterProgress: [] };
    const streamIds = streams.map((stream) => stream.id);
    const [classes, chapters] = await Promise.all([
      rows(client.from("classrooms").select("id, stream_id, name, created_at").in("stream_id", streamIds).order("created_at")),
      rows(client.from("chapters").select("id, stream_id, title, subject, published_at, created_at").in("stream_id", streamIds).order("created_at", { ascending: false })),
    ]);
    const classIds = classes.map((item) => item.id);
    const chapterIds = chapters.map((item) => item.id);
    const [assignments, invites, members, questionRows, matches, progressByStream, ratings] = await Promise.all([
      chapterIds.length ? rows(client.from("chapter_classes").select("chapter_id, class_id").in("chapter_id", chapterIds)) : [],
      classIds.length ? rows(client.from("class_invites").select("code, class_id, expires_at").in("class_id", classIds).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false })) : [],
      classIds.length ? rows(client.from("class_members").select("class_id, user_id, joined_at").in("class_id", classIds)) : [],
      chapterIds.length ? rows(client.from("chapter_questions").select("id, chapter_id").in("chapter_id", chapterIds)) : [],
      rows(client.from("matches").select("id, chapter_id, stream_id, player_one_id, player_two_id, status, winner_id, started_at, resolved_at, rating_changes")
        .in("stream_id", streamIds).order("started_at", { ascending: false })),
      Promise.all(streamIds.map((streamId) => rows(client.rpc("get_teacher_chapter_progress", { p_stream_id: streamId })))),
      rows(client.from("stream_ratings").select("stream_id, user_id, rating").in("stream_id", streamIds)),
    ]);
    const chapterProgress = progressByStream.flat();
    const memberIds = [...new Set(members.map((member) => member.user_id))];
    const people = memberIds.length
      ? await rows(client.from("user_profiles").select("id, display_name, role").in("id", memberIds))
      : [];
    const questionCounts = Object.fromEntries(chapters.map((chapter) => [chapter.id, 0]));
    questionRows.forEach((question) => { questionCounts[question.chapter_id] = (questionCounts[question.chapter_id] || 0) + 1; });
    return { streams, classes, chapters, assignments, invites, members, people, questionCounts, matches, chapterProgress, ratings };
  }

  async function loadStudentData(userId) {
    const memberships = await rows(client.from("class_members")
      .select("class_id, classrooms(id, name, stream_id)").eq("user_id", userId));
    const classes = memberships.map((membership) => membership.classrooms).filter(Boolean);
    const classIds = [...new Set(classes.map((item) => item.id))];
    const streamIds = [...new Set(classes.map((item) => item.stream_id))];
    const [streams, chapterLinks, members, challenges, initialMatches, ratings] = await Promise.all([
      streamIds.length ? rows(client.from("teacher_streams").select("id, name, owner_user_id").in("id", streamIds)) : [],
      classIds.length ? rows(client.from("chapter_classes").select("chapter_id, class_id").in("class_id", classIds)) : [],
      classIds.length ? rows(client.from("class_members").select("class_id, user_id").in("class_id", classIds)) : [],
      rows(client.from("challenges").select("id, chapter_id, challenger_id, opponent_id, status, created_at, expires_at, accepted_at")
        .or(`challenger_id.eq.${userId},opponent_id.eq.${userId}`).order("created_at", { ascending: false }).limit(50)),
      rows(client.from("matches").select("id, chapter_id, stream_id, player_one_id, player_two_id, status, deadline_at, winner_id, forfeit_by, rating_changes, started_at, resolved_at")
        .or(`player_one_id.eq.${userId},player_two_id.eq.${userId}`).order("started_at", { ascending: false }).limit(50)),
      streamIds.length ? rows(client.from("stream_ratings").select("stream_id, user_id, rating").in("stream_id", streamIds)) : [],
    ]);
    const matches = await Promise.all(initialMatches.map(async (match) => {
      if (match.status !== "active") return match;
      const { data, error } = await client.rpc("refresh_match", { p_match_id: match.id });
      if (error) throw error;
      return { ...match, ...data };
    }));
    const chapterIds = [...new Set(chapterLinks.map((link) => link.chapter_id))];
    const matchIds = matches.map((match) => match.id);
    const [chapters, questionRows, attempts] = await Promise.all([
      chapterIds.length ? rows(client.from("chapters").select("id, stream_id, title, subject, published_at").in("id", chapterIds).not("published_at", "is", null)) : [],
      chapterIds.length ? rows(client.from("chapter_questions").select("id, chapter_id").in("chapter_id", chapterIds)) : [],
      matchIds.length ? rows(client.from("match_attempts").select("match_id, answers, submitted_at").eq("user_id", userId).in("match_id", matchIds)) : [],
    ]);
    const peopleIds = [...new Set(members.map((member) => member.user_id))];
    const people = peopleIds.length
      ? await rows(client.from("user_profiles").select("id, display_name, role").in("id", peopleIds))
      : [];
    const questionCounts = Object.fromEntries(chapters.map((chapter) => [chapter.id, 0]));
    questionRows.forEach((question) => { questionCounts[question.chapter_id] = (questionCounts[question.chapter_id] || 0) + 1; });
    return { streams, classes, chapterLinks, chapters, members, people, challenges, matches, ratings, attempts, questionCounts };
  }

  async function loadData() {
    const generation = ++loadGeneration;
    const userId = context.session.user.id;
    const hadData = model.loaded;
    model.loading = true;
    model.error = null;
    if (!hadData) loadingView();
    try {
      const data = model.role === "teacher" ? await loadTeacherData(userId) : await loadStudentData(userId);
      if (generation !== loadGeneration) return;
      const knownMatches = new Set((model.matches || []).map((match) => match.id));
      const newTimedMatch = hadData && model.role === "student" && data.matches.find((match) => match.status === "active" && !knownMatches.has(match.id));
      Object.assign(model, data, { loaded: true, loading: false, error: null });
      if (newTimedMatch) model.activeTab = "matches";
      renderBody();
      if (newTimedMatch) toast("Your timed match has started. Open it now; the timer is running.");
    } catch (error) {
      if (generation !== loadGeneration) return;
      Object.assign(model, { loaded: false, loading: false, error });
      errorView(error);
    }
  }

  function render(contextValue) {
    if (contextValue) {
      context = contextValue;
      const userId = context.session?.user?.id;
      const role = context.profile?.role;
      if (userId !== model.userId || role !== model.role) {
        loadGeneration += 1;
        Object.assign(model, { userId, role, profile: context.profile, loaded: false, loading: false, error: null, activeTab: null });
      } else {
        model.role = context.profile?.role;
        model.profile = context.profile;
      }
    }
    if (!context?.session?.user) return;
    if (!model.profile) {
      root.innerHTML = `${header("ACCOUNT SETUP", "Your profile is unavailable", "Please try again. Contact your school if the problem continues.")}<div class="empty-state"><strong>${escape(errorMessage({ message: context.profileError }, "Your account information is temporarily unavailable."))}</strong></div>`;
      return;
    }
    if (model.loading && !model.loaded) return loadingView();
    if (model.error) return errorView(model.error);
    if (!model.loaded) return loadData();
    renderBody();
  }

  function renderBody() {
    if (model.role === "teacher") renderTeacher();
    else renderStudent();
    if (model.activeTab) {
      const selected = [...root.querySelectorAll("[data-live-tab]")].find((button) => button.dataset.liveTab === model.activeTab);
      if (selected) {
        root.querySelectorAll("[data-live-tab]").forEach((button) => button.classList.toggle("active", button === selected));
        root.querySelectorAll("[data-live-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.livePanel === model.activeTab));
      }
    }
  }

  function refresh() {
    if (!context?.session?.user) return;
    if (model.loading) return;
    model.error = null;
    return loadData();
  }

  function bindLiveTabs() {
    const buttons = [...root.querySelectorAll("[data-live-tab]")];
    buttons.forEach((button) => button.addEventListener("click", () => {
      model.activeTab = button.dataset.liveTab;
      buttons.forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      root.querySelectorAll("[data-live-panel]").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.livePanel === button.dataset.liveTab);
      });
    }));
  }

  function renderTeacher() {
    const stream = model.streams[0];
    const classCount = model.classes.length;
    const studentCount = new Set(model.members.map((member) => member.user_id)).size;
    const publishedCount = model.chapters.filter((chapter) => chapter.published_at).length;
    const createChapter = stream && classCount
      ? `<button class="button button-primary" id="liveCreateChapter">＋ New chapter</button>` : "";
    root.innerHTML = `${header("TEACHER WORKSPACE", stream?.name || `Welcome, ${model.profile.display_name}`, "Chapters, classes, and student progress.", `<div class="live-header-actions"><button class="button button-outline" id="liveRefresh">Refresh</button>${createChapter}</div>`)}
      ${stream ? `
        <div class="stats-grid">${statCard("▤", publishedCount, "Published chapters")}${statCard("♙", studentCount, "Students connected")}${statCard("▦", classCount, "Classes")}</div>
        <nav class="tab-bar" aria-label="Teacher workspace sections"><button class="tab-button active" data-live-tab="chapters">Chapters</button><button class="tab-button" data-live-tab="results">Results</button><button class="tab-button" data-live-tab="classes">Classes</button></nav>
        <section class="tab-panel active" data-live-panel="chapters"><div class="section-heading"><div><h2>Your chapters</h2><p>Drafts stay private. Published chapters are available to their assigned classes.</p></div><span class="small">${model.chapters.length} total</span></div><div class="card-grid">${model.chapters.map(renderTeacherChapter).join("") || `<div class="empty-state"><strong>No chapters yet</strong>Create your first chapter for your classes.</div>`}</div>${classCount ? "" : `<div class="empty-state"><strong>Add your first class</strong>Next, create a class, generate its join code, and share it with your students.<button class="button button-primary" id="liveAddFirstClass">Add class</button></div>`}</section>
        <section class="tab-panel" data-live-panel="results">${renderTeacherResults()}</section>
        <section class="tab-panel" data-live-panel="classes"><div class="section-heading"><div><h2>Your classes</h2><p>Share a class code so students can join with their own account.</p></div><button class="button button-secondary" id="liveAddClass">＋ Add class</button></div><div class="class-grid">${model.classes.map(renderTeacherClass).join("") || `<div class="empty-state"><strong>No classes yet</strong>Add your first class to invite students and publish chapters.</div>`}</div></section>`
        : `<section class="live-onboarding"><div class="live-onboarding-step">01</div><p class="eyebrow">FIRST STEP</p><h2>Create your teaching space</h2><p class="lede">Name your teaching space and add your first classes. You can create invite codes for students as soon as the classes are saved.</p><button class="button button-primary" id="liveCreateStream">Create teaching space <span aria-hidden="true">→</span></button></section>`}`;

    root.querySelector("#liveRefresh")?.addEventListener("click", () => refresh());
    root.querySelector("#liveCreateChapter")?.addEventListener("click", () => openChapterEditor());
    root.querySelector("#liveCreateStream")?.addEventListener("click", () => openStreamEditor());
    root.querySelector("#liveAddFirstClass")?.addEventListener("click", () => openClassEditor(stream));
    root.querySelector("#liveAddClass")?.addEventListener("click", () => openClassEditor(stream));
    root.querySelectorAll("[data-edit-chapter]").forEach((button) => button.addEventListener("click", () => openChapterEditor(button.dataset.editChapter)));
    root.querySelectorAll("[data-new-invite]").forEach((button) => button.addEventListener("click", () => createInvite(button.dataset.newInvite, button)));
    root.querySelectorAll("[data-copy-invite]").forEach((button) => button.addEventListener("click", () => copyInvite(button.dataset.copyInvite)));
    root.querySelectorAll("[data-remove-student]").forEach((button) => button.addEventListener("click", () => removeStudentFromClass(button)));
    root.querySelectorAll("[data-student-profile]").forEach((button) => button.addEventListener("click", () => openStudentProfile(button.dataset.studentProfile)));
    bindLiveTabs();
  }

  function renderTeacherResults() {
    const chapters = model.chapters.filter((chapter) => chapter.published_at);
    if (!chapters.length) return `<div class="section-heading"><div><h2>Student results</h2><p>Match activity is grouped by chapter and student.</p></div></div><div class="empty-state"><strong>No published chapters yet</strong>Results will appear after students complete ranked matches.</div>`;
    return `<div class="section-heading"><div><h2>Student results</h2><p>Match activity is grouped by chapter and student.</p></div></div>${chapters.map((chapter) => {
      const classIds = new Set(model.assignments.filter((item) => item.chapter_id === chapter.id).map((item) => item.class_id));
      const classes = model.classes.filter((classroom) => classIds.has(classroom.id));
      const studentIds = new Set(model.members.filter((member) => classIds.has(member.class_id)).map((member) => member.user_id));
      const students = [...studentIds].map((id) => model.people.find((person) => person.id === id)).filter((person) => person?.role === "student");
      const matchRows = students.map((student) => {
        const stats = model.chapterProgress.find((item) => item.chapter_id === chapter.id && item.user_id === student.id);
        const classNames = classes.filter((classroom) => model.members.some((member) => member.class_id === classroom.id && member.user_id === student.id)).map((classroom) => classroom.name);
        return `<tr><td>${studentProfileButton(student)}</td><td>${escape(classNames.join(", "))}</td><td>${Number(stats?.match_count || 0)}</td><td>${Number(stats?.submitted_count || 0)}</td><td>${Number(stats?.correct_count || 0)} / ${Number(stats?.question_count || 0)}</td><td>${Number(stats?.win_count || 0)}</td></tr>`;
      }).join("");
      return `<section class="live-progress-section"><div class="section-heading"><div><h3>${escape(chapter.title)}</h3><p>${escape(chapter.subject || "General")} · ${classes.length} ${classes.length === 1 ? "class" : "classes"} · ${model.matches.filter((match) => match.chapter_id === chapter.id).length} ranked matches</p></div></div>${matchRows ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Class</th><th>Matches</th><th>Submitted</th><th>Correct answers</th><th>Wins</th></tr></thead><tbody>${matchRows}</tbody></table></div>` : `<div class="empty-state"><strong>No students in assigned classes yet</strong>Student activity will appear here after they join.</div>`}</section>`;
    }).join("")}`;
  }

  function renderTeacherChapter(chapter) {
    const assignmentIds = model.assignments.filter((item) => item.chapter_id === chapter.id).map((item) => item.class_id);
    const names = model.classes.filter((item) => assignmentIds.includes(item.id)).map((item) => item.name);
    const published = Boolean(chapter.published_at);
    const count = model.questionCounts?.[chapter.id] || 0;
    return `<article class="surface-card set-card"><div class="set-card-top"><span class="subject-tag">${escape(chapter.subject || "General")}</span><span class="state-tag ${published ? "published" : ""}">${published ? "Published" : "Draft"}</span></div><span class="set-icon" aria-hidden="true">✳</span><h3>${escape(chapter.title)}</h3><p class="set-meta">${count} questions${names.length ? ` · ${escape(names.join(" · "))}` : ""}</p><div class="set-card-footer">${published ? `<span class="small">Live since ${new Date(chapter.published_at).toLocaleDateString()}</span>` : ""}<button class="button button-outline" data-edit-chapter="${escape(chapter.id)}">${published ? "Edit chapter" : "Continue draft →"}</button></div></article>`;
  }

  function renderTeacherClass(classroom) {
    const memberIds = [...new Set(model.members.filter((member) => member.class_id === classroom.id).map((member) => member.user_id))];
    const people = memberIds.map((id) => model.people.find((person) => person.id === id)).filter(Boolean);
    const invite = model.invites.find((item) => item.class_id === classroom.id);
    const memberList = people.length
      ? `<div class="class-list">${people.map((person) => `<div class="class-member-row"><div class="player-block"><span class="avatar">${escape((person.display_name || "S").slice(0, 1).toUpperCase())}</span><div class="player-copy">${studentProfileButton(person)}<span class="small">${studentRating(person.id, classroom.stream_id)} ELO</span></div></div><button class="button button-quiet" type="button" data-remove-student="${escape(classroom.id)}" data-student-id="${escape(person.id)}" data-student-name="${escape(person.display_name)}" aria-label="Remove ${escape(person.display_name)} from ${escape(classroom.name)}">Remove</button></div>`).join("")}</div>`
      : `<div class="empty-state"><strong>No students yet</strong>Share the join code below to invite the class.</div>`;
    return `<article class="surface-card class-card"><div class="class-card-head"><div><h3>${escape(classroom.name)}</h3><span class="small">${people.length} ${people.length === 1 ? "student" : "students"}</span></div><span class="class-chip">CLASS</span></div>${memberList}<div class="live-invite-box">${invite ? `<div><span class="small">Class join code</span><strong class="live-code">${escape(invite.code.match(/.{1,4}/g).join(" "))}</strong><span class="small">Expires ${new Date(invite.expires_at).toLocaleDateString()}</span></div><button class="button button-outline" data-copy-invite="${escape(invite.code)}">Copy code</button>` : `<span class="small">Create a code to let students join.</span><button class="button button-secondary" data-new-invite="${escape(classroom.id)}">Create join code</button>`}</div></article>`;
  }

  function studentRating(userId, streamId) {
    return model.ratings.find((rating) => rating.user_id === userId && rating.stream_id === streamId)?.rating ?? 1000;
  }

  function studentProfileButton(student) {
    return `<button type="button" class="profile-name-button" data-student-profile="${escape(student.id)}" aria-label="View profile of ${escape(student.display_name)}">${escape(student.display_name)}</button>`;
  }

  function openStudentProfile(studentId) {
    if (model.role !== "teacher") return;
    const student = model.people.find((person) => person.id === studentId && person.role === "student");
    const memberships = model.members.filter((member) => member.user_id === studentId);
    if (!student || !memberships.length) return;
    const classIds = new Set(memberships.map((member) => member.class_id));
    const classes = model.classes.filter((classroom) => classIds.has(classroom.id));
    const streams = model.streams.filter((stream) => classes.some((classroom) => classroom.stream_id === stream.id));
    const progress = model.chapterProgress.filter((entry) => entry.user_id === studentId);
    const correct = progress.reduce((total, entry) => total + Number(entry.correct_count), 0);
    const questions = progress.reduce((total, entry) => total + Number(entry.question_count), 0);
    const matches = model.matches.filter((match) => [match.player_one_id, match.player_two_id].includes(studentId));
    const wins = matches.filter((match) => match.winner_id === studentId).length;
    const assignedIds = new Set(model.assignments.filter((assignment) => classIds.has(assignment.class_id)).map((assignment) => assignment.chapter_id));
    const chapters = model.chapters.filter((chapter) => chapter.published_at && (assignedIds.has(chapter.id) || progress.some((entry) => entry.chapter_id === chapter.id)));
    const chapterRows = chapters.map((chapter) => {
      const stats = progress.find((entry) => entry.chapter_id === chapter.id);
      return `<tr><td><strong>${escape(chapter.title)}</strong><span class="small profile-subline">${escape(chapter.subject)}</span></td><td>${Number(stats?.match_count || 0)}</td><td>${Number(stats?.correct_count || 0)} / ${Number(stats?.question_count || 0)}</td><td>${Number(stats?.win_count || 0)}</td></tr>`;
    }).join("");
    const recentRows = matches.slice(0, 8).map((match) => {
      const opponentId = match.player_one_id === studentId ? match.player_two_id : match.player_one_id;
      const opponent = model.people.find((person) => person.id === opponentId);
      const chapter = model.chapters.find((item) => item.id === match.chapter_id);
      const outcome = match.status === "active" ? "In progress" : match.status === "no_contest" ? "No contest"
        : match.status === "forfeit" ? (match.winner_id === studentId ? "Won by forfeit" : "Forfeited")
          : match.winner_id === studentId ? "Won" : match.winner_id ? "Lost" : "Draw";
      const change = match.rating_changes?.[studentId];
      return `<tr><td><strong>${escape(chapter?.title || "Chapter")}</strong><span class="small profile-subline">${escape(opponent?.display_name || "Opponent")} · ${new Date(match.started_at).toLocaleDateString()}</span></td><td>${outcome}</td><td>${Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change} ELO` : "Not rated"}</td></tr>`;
    }).join("");
    const metric = (value, label) => `<div class="profile-metric"><strong>${value}</strong><span>${label}</span></div>`;
    openModal(`<div class="student-profile"><div class="modal-header"><p class="eyebrow">STUDENT PROFILE</p><button class="button button-quiet" id="liveCloseStudentProfile" type="button">Close</button></div><div class="profile-heading"><span class="profile-avatar" aria-hidden="true">${escape(student.display_name.slice(0, 1).toUpperCase())}</span><div class="profile-identity"><h2 id="modalTitle">${escape(student.display_name)}</h2><p>${escape(classes.map((classroom) => classroom.name).join(" · "))}</p></div></div><div class="profile-rating-list">${streams.map((stream) => `<div class="profile-rating"><strong>${studentRating(studentId, stream.id)} <small>ELO</small></strong><span>${escape(stream.name)}</span></div>`).join("")}</div><div class="profile-metrics">${metric(matches.length, "Matches")}${metric(wins, "Wins")}${metric(questions ? `${Math.round(correct / questions * 100)}%` : "—", "Accuracy")}${metric(`${correct} / ${questions}`, "Correct answers")}</div><section class="profile-section"><h3>Classes</h3><ul class="profile-memberships">${classes.map((classroom) => {
      const membership = memberships.find((member) => member.class_id === classroom.id);
      return `<li><strong>${escape(classroom.name)}</strong><span>Joined ${new Date(membership.joined_at).toLocaleDateString()}</span></li>`;
    }).join("")}</ul></section><section class="profile-section"><h3>Chapter progress</h3>${chapterRows ? `<div class="table-wrap"><table class="profile-table"><thead><tr><th>Chapter</th><th>Matches</th><th>Correct answers</th><th>Wins</th></tr></thead><tbody>${chapterRows}</tbody></table></div>` : `<p class="small">No published chapters assigned yet.</p>`}</section><section class="profile-section"><h3>Recent matches</h3>${recentRows ? `<div class="table-wrap"><table class="profile-table"><thead><tr><th>Chapter / opponent</th><th>Result</th><th>Rating change</th></tr></thead><tbody>${recentRows}</tbody></table></div>` : `<p class="small">No matches played yet.</p>`}</section></div>`);
    document.getElementById("liveCloseStudentProfile").addEventListener("click", closeModal);
  }

  function renderRatingOverview() {
    return `<div class="rating-overviews">${model.streams.map((stream) => {
      const rating = studentRating(model.userId, stream.id);
      const latest = model.matches.filter((match) => match.stream_id === stream.id && match.status === "completed")
        .sort((first, second) => new Date(second.resolved_at || second.started_at) - new Date(first.resolved_at || first.started_at))[0];
      const change = latest?.rating_changes?.[model.userId];
      const classes = model.classes.filter((classroom) => classroom.stream_id === stream.id);
      return `<section class="rating-overview" aria-label="${escape(stream.name)} rating"><div class="rating-main"><span class="eyebrow">YOUR ELO</span><strong class="rating-number">${rating}<small>ELO</small></strong><span>${escape(stream.name)}</span></div><div class="rating-meta"><div><span>Latest rating change</span><strong class="${Number(change) < 0 ? "is-incorrect" : "is-correct"}">${Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change} ELO` : "No recent rating change"}</strong></div><div><span>Classes</span><strong>${escape(classes.map((classroom) => classroom.name).join(" · "))}</strong></div></div></section>`;
    }).join("")}</div>`;
  }

  async function removeStudentFromClass(button) {
    const classId = button.dataset.removeStudent;
    const studentId = button.dataset.studentId;
    const studentName = button.dataset.studentName;
    const classroom = model.classes.find((item) => item.id === classId);
    if (!window.confirm(`Remove ${studentName} from ${classroom?.name || "this class"}? Their account and past match history will remain.`)) return;
    button.disabled = true;
    try {
      const { data, error } = await client.rpc("remove_student_from_class", { p_class_id: classId, p_student_id: studentId });
      if (error) throw error;
      toast(data?.removed ? `${studentName} removed from class.` : `${studentName} is no longer in this class.`);
      await refresh();
    } catch (error) {
      button.disabled = false;
      toast(errorMessage(error, "Could not remove this student."));
    }
  }

  function openStreamEditor() {
    openModal(`<div class="modal-header"><div><p class="eyebrow">YOUR CLASSES</p><h2 id="modalTitle">Create your teaching space</h2></div><button class="button button-quiet" id="liveCloseStream" type="button">Close</button></div><p class="modal-description">Name your teaching space, then list your first classes separated by commas.</p><div class="field"><label for="liveStreamName">Teaching space name</label><input id="liveStreamName" maxlength="100" placeholder="For example, Marina's history classes" required></div><div class="field"><label for="liveClassNames">First classes</label><input id="liveClassNames" maxlength="500" placeholder="Grade 11A, Grade 11B" required></div><div class="modal-footer"><span class="small">Your classes</span><button class="button button-primary" id="liveSaveStream" type="button">Create teaching space</button></div>`);
    document.getElementById("liveCloseStream").addEventListener("click", closeModal);
    document.getElementById("liveSaveStream").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const name = document.getElementById("liveStreamName").value.trim();
      const classNames = document.getElementById("liveClassNames").value.split(",").map((item) => item.trim()).filter(Boolean);
      if (!name || !classNames.length) return toast("Add a teaching space name and at least one class.");
      if (classNames.length > 30) return toast("Add no more than 30 classes at once.");
      if (new Set(classNames.map((item) => item.toLocaleLowerCase())).size !== classNames.length) return toast("Class names must be unique.");
      const originalLabel = button.textContent;
      button.disabled = true; button.textContent = "Creating...";
      try {
        const { error } = await client.rpc("create_teacher_space", { p_name: name, p_class_names: classNames });
        if (error) throw error;
        closeModal();
        toast("Teaching space created.");
        await refresh();
      } catch (error) {
        button.disabled = false; button.textContent = originalLabel;
        toast(errorMessage(error, "Could not create the teaching space."));
      }
    });
  }

  function openClassEditor(stream) {
    if (!stream) return;
    openModal(`<div class="modal-header"><div><p class="eyebrow">CLASSROOMS</p><h2 id="modalTitle">Add a class</h2></div><button class="button button-quiet" id="liveCloseClass" type="button">Close</button></div><p class="modal-description">Students join with a code you share after creating the class.</p><div class="field"><label for="liveClassName">Class name</label><input id="liveClassName" maxlength="100" placeholder="For example, Grade 10A" required></div><div class="modal-footer"><span class="small">${escape(stream.name)}</span><button class="button button-primary" id="liveSaveClass" type="button">Add class</button></div>`);
    document.getElementById("liveCloseClass").addEventListener("click", closeModal);
    document.getElementById("liveSaveClass").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const name = document.getElementById("liveClassName").value.trim();
      if (!name) return toast("Enter a class name.");
      const originalLabel = button.textContent;
      button.disabled = true; button.textContent = "Adding...";
      try {
        await rows(client.from("classrooms").insert({ stream_id: stream.id, name }));
        closeModal();
        toast("Class added.");
        await refresh();
      } catch (error) {
        button.disabled = false; button.textContent = originalLabel;
        toast(errorMessage(error, "Could not add this class."));
      }
    });
  }

  async function createInvite(classId, button) {
    button.disabled = true;
    try {
      const { data, error } = await client.rpc("create_class_invite", { p_class_id: classId });
      if (error) throw error;
      toast(`Join code created: ${data}`);
      await refresh();
    } catch (error) {
      button.disabled = false;
      toast(errorMessage(error, "Could not create a class code."));
    }
  }

  async function copyInvite(code) {
    try {
      await navigator.clipboard.writeText(code);
      toast("Class code copied.");
    } catch {
      openModal(`<div class="modal-header"><div><p class="eyebrow">CLASS INVITATION</p><h2 id="modalTitle">Copy this join code</h2></div><button class="button button-quiet" id="closeInviteCopy" type="button">Close</button></div><div class="field"><label for="inviteCodeValue">Class code</label><input id="inviteCodeValue" value="${escape(code)}" readonly></div><p class="small">Students can enter this code from their account screen.</p>`);
      document.getElementById("closeInviteCopy").addEventListener("click", closeModal);
      document.getElementById("inviteCodeValue").select();
    }
  }

  async function openChapterEditor(chapterId = null) {
    const userId = model.userId;
    const stream = model.streams[0];
    if (!stream || !model.classes.length) return toast("Create a class before building a chapter.");
    const existing = chapterId ? model.chapters.find((chapter) => chapter.id === chapterId) : null;
    const publishedExisting = Boolean(existing?.published_at);
    let questions = [];
    if (existing) {
      try {
        const saved = await rows(client.from("chapter_questions").select("id, position, prompt, options").eq("chapter_id", existing.id).order("position"));
        const ids = saved.map((question) => question.id);
        const keys = ids.length ? await rows(client.from("question_answer_keys").select("question_id, correct_option_index, explanation").in("question_id", ids)) : [];
        if (!isCurrentUser(userId)) return;
        const keyMap = Object.fromEntries(keys.map((key) => [key.question_id, key]));
        questions = saved.map((question) => ({
          prompt: question.prompt,
          options: question.options,
          correct: keyMap[question.id]?.correct_option_index ?? 0,
          explanation: keyMap[question.id]?.explanation || "",
        }));
      } catch (error) {
        return toast(errorMessage(error, "Could not load this draft."));
      }
    }
    const selected = new Set(model.assignments.filter((item) => item.chapter_id === chapterId).map((item) => item.class_id));
    const questionDrafts = new Map();
    const resetQuestionEditor = () => {
      ["livePrompt", "liveOption0", "liveOption1", "liveOption2", "liveOption3", "liveExplanation"].forEach((id) => { document.getElementById(id).value = ""; });
      document.getElementById("liveCorrect").value = "0";
    };
    const readQuestion = (editor) => ({
      prompt: editor.querySelector('[name="prompt"]').value.trim(),
      options: [0, 1, 2, 3].map((index) => editor.querySelector('[name="option' + index + '"]').value.trim()),
      correct: Number(editor.querySelector('[name="correct"]').value),
      explanation: editor.querySelector('[name="explanation"]').value.trim(),
    });
    const completeQuestion = (question) => question.prompt && question.options.every(Boolean);
    const drawQuestions = () => {
      const list = document.getElementById("liveQuestionList");
      document.getElementById("liveQuestionCount").textContent = '· ' + questions.length;
      document.getElementById("livePublishHint").textContent = questions.length >= 15 ? "Ready to publish" : (15 - questions.length) + " more questions needed to publish";
      list.innerHTML = questions.map((question, index) => {
        const draft = questionDrafts.get(question) || question;
        const field = (label, name, value, max, textarea = false) => '<div class="field"><label for="edit-' + index + '-' + name + '">' + label + '</label>' + (textarea ? '<textarea rows="2"' : '<input') + ' id="edit-' + index + '-' + name + '" name="' + name + '" maxlength="' + max + '"' + (textarea ? '>' + escape(value) + '</textarea>' : ' value="' + escape(value) + '">') + '</div>';
        return '<details class="chapter-question" data-question="' + index + '" ' + (questionDrafts.has(question) ? 'open' : '') + '><summary><span class="question-row-copy"><strong>' + (index + 1) + '. ' + escape(question.prompt) + '</strong><span>Correct: ' + 'ABCD'[question.correct] + ' · ' + escape(question.options[question.correct]) + '</span></span><span class="question-edit-label">Edit ⌄</span></summary><div class="chapter-question-fields">' + field('Question', 'prompt', draft.prompt, 2000, true) + '<div class="form-grid">' + draft.options.map((option, i) => field('Option ' + 'ABCD'[i], 'option' + i, option, 500)).join('') + '</div><div class="field"><label for="edit-' + index + '-correct">Correct option</label><select id="edit-' + index + '-correct" name="correct">' + [0,1,2,3].map((i) => '<option value="' + i + '" ' + (draft.correct === i ? 'selected' : '') + '>' + 'ABCD'[i] + '</option>').join('') + '</select></div>' + field('Explanation (optional)', 'explanation', draft.explanation, 4000, true) + '<p class="small question-edit-status" role="status" aria-live="polite"></p><div class="question-row-actions"><button class="button button-secondary" type="button" data-apply-question>Done</button><button class="button button-quiet" type="button" data-cancel-question>Cancel</button><button class="button button-quiet" type="button" data-live-remove="' + index + '">Remove question</button></div></div></details>';
      }).join("") || '<p class="small">Add your first question below.</p>';
      list.querySelectorAll("[data-question]").forEach((editor) => {
        const question = questions[Number(editor.dataset.question)];
        const remember = () => {
          questionDrafts.set(question, readQuestion(editor));
          editor.querySelector(".question-edit-status").textContent = "Changes will be saved with the chapter.";
        };
        editor.addEventListener("input", remember);
        editor.addEventListener("change", remember);
        const redraw = () => {
          drawQuestions();
          list.querySelector('[data-question="' + questions.indexOf(question) + '"] summary')?.focus();
        };
        editor.querySelector("[data-apply-question]").addEventListener("click", () => {
          const draft = readQuestion(editor);
          if (!completeQuestion(draft)) {
            editor.querySelector(".question-edit-status").textContent = "Enter the question and all four answer choices.";
            return;
          }
          Object.assign(question, draft);
          questionDrafts.delete(question);
          redraw();
        });
        editor.querySelector("[data-cancel-question]").addEventListener("click", () => {
          questionDrafts.delete(question);
          redraw();
        });
        editor.querySelector("[data-live-remove]").addEventListener("click", () => {
          questionDrafts.delete(question);
          questions.splice(questions.indexOf(question), 1);
          drawQuestions();
        });
      });
    };
    openModal(`<div class="modal-header"><div><p class="eyebrow">CHAPTER EDITOR</p><h2 id="modalTitle">${publishedExisting ? "Edit published chapter" : existing ? "Edit draft" : "Create a chapter"}</h2></div><button class="button button-quiet" id="liveCloseChapter" type="button">Close</button></div><p class="modal-description">${publishedExisting ? "Changes apply to future practice and matches. Existing matches keep their original questions; open invitations will be cancelled." : "Add four choices and a correct answer for each question. At least 15 complete questions are required to publish."}</p><div class="form-grid"><div class="field"><label for="liveChapterTitle">Chapter title</label><input id="liveChapterTitle" maxlength="160" value="${escape(existing?.title || "")}" placeholder="For example, World War I" required></div><div class="field"><label for="liveChapterSubject">Subject</label><input id="liveChapterSubject" maxlength="100" value="${escape(existing?.subject || "")}" placeholder="History"></div></div><div class="field"><span class="field-label">Assign to classes</span><div class="live-check-list">${model.classes.map((classroom) => `<label><input type="checkbox" value="${escape(classroom.id)}" ${selected.has(classroom.id) || (!existing && model.classes.length === 1) ? "checked" : ""}><span>${escape(classroom.name)}</span></label>`).join("")}</div></div><div class="question-editor chapter-question-editor"><div class="live-editor-heading"><h3>Questions <span class="small" id="liveQuestionCount"></span></h3></div><div class="question-list" id="liveQuestionList"></div><h3 id="liveQuestionEditorTitle">Add a question</h3><div class="field"><label for="livePrompt">Question</label><textarea id="livePrompt" rows="2" maxlength="2000" placeholder="Write a clear question"></textarea></div><div class="form-grid">${[0, 1, 2, 3].map((index) => `<div class="field"><label for="liveOption${index}">Option ${"ABCD"[index]}</label><input id="liveOption${index}" maxlength="500"></div>`).join("")}<div class="field"><label for="liveCorrect">Correct option</label><select id="liveCorrect"><option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option></select></div><div class="field"><label for="liveExplanation">Explanation (optional)</label><input id="liveExplanation" maxlength="4000"></div></div><button class="button button-secondary" id="liveAddQuestion" type="button">＋ Add question</button><p class="small">Question changes are saved when you save the chapter.</p></div><div class="modal-footer"><span class="small" id="livePublishHint"></span><div class="modal-actions">${publishedExisting ? `<button class="button button-primary" id="livePublish" type="button">Save changes</button>` : `<button class="button button-outline" id="liveSaveDraft" type="button">Save draft</button><button class="button button-primary" id="livePublish" type="button">${existing ? "Save and publish" : "Publish chapter"}</button>`}</div></div>`);
    drawQuestions();
    document.getElementById("liveCloseChapter").addEventListener("click", closeModal);
    document.getElementById("liveAddQuestion").addEventListener("click", () => {
      const prompt = document.getElementById("livePrompt").value.trim();
      const options = [0, 1, 2, 3].map((index) => document.getElementById(`liveOption${index}`).value.trim());
      if (!prompt || options.some((option) => !option)) return toast("Add the question and all four answer choices.");
      const question = { prompt, options, correct: Number(document.getElementById("liveCorrect").value), explanation: document.getElementById("liveExplanation").value.trim() };
      questions.push(question);
      resetQuestionEditor();
      drawQuestions();
      document.getElementById("livePrompt").focus();
    });
    const save = async (publish, button) => {
      for (const [question, draft] of questionDrafts) {
        if (!completeQuestion(draft)) {
          const editor = document.querySelector('[data-question="' + questions.indexOf(question) + '"]');
          editor.open = true;
          editor.querySelector(".question-edit-status").textContent = "Enter the question and all four answer choices.";
          editor.querySelector('[name="prompt"]').focus();
          return;
        }
      }
      for (const [question, draft] of questionDrafts) Object.assign(question, draft);
      questionDrafts.clear();
      const publishChapter = publish || publishedExisting;
      const title = document.getElementById("liveChapterTitle").value.trim();
      const classIds = [...document.querySelectorAll(".live-check-list input:checked")].map((input) => input.value);
      const pendingPrompt = document.getElementById("livePrompt").value.trim();
      const pendingOptions = [0, 1, 2, 3].map((index) => document.getElementById(`liveOption${index}`).value.trim());
      const pendingExplanation = document.getElementById("liveExplanation").value.trim();
      const hasPendingQuestion = pendingPrompt || pendingOptions.some(Boolean) || pendingExplanation;
      if (hasPendingQuestion && (!pendingPrompt || pendingOptions.some((option) => !option))) return toast("Finish adding the question in the editor, or clear its fields before saving.");
      if (!title) return toast("Add a chapter title.");
      if (!classIds.length) return toast("Assign the chapter to at least one class.");
      if (hasPendingQuestion) {
        const question = { prompt: pendingPrompt, options: pendingOptions, correct: Number(document.getElementById("liveCorrect").value), explanation: pendingExplanation };
        questions.push(question);
        resetQuestionEditor();
        drawQuestions();
      }
      if (questions.length > 100) return toast("A chapter can contain no more than 100 questions.");
      if (publishChapter && questions.length < 15) return toast("Add at least 15 questions before publishing.");
      const confirmation = publishedExisting
        ? "Save changes to this published chapter? Existing matches keep their original questions and open invitations will be cancelled."
        : "Publish this chapter? Assigned students will be able to challenge one another on it.";
      if (publishChapter && !window.confirm(confirmation)) return;
      button.disabled = true;
      try {
        const { error } = await client.rpc("save_chapter", {
          p_stream_id: stream.id,
          p_chapter_id: existing?.id || null,
          p_title: title,
          p_subject: document.getElementById("liveChapterSubject").value.trim(),
          p_class_ids: classIds,
          p_questions: questions.map((question) => ({ prompt: question.prompt, options: question.options, correct_option_index: question.correct, explanation: question.explanation })),
          p_publish: publishChapter,
        });
        if (error) throw error;
        closeModal();
        toast(publishChapter ? "Chapter saved." : "Draft saved.");
        await refresh();
      } catch (error) {
        button.disabled = false;
        toast(errorMessage(error, "Could not save this chapter."));
      }
    };
    document.getElementById("liveSaveDraft")?.addEventListener("click", (event) => save(false, event.currentTarget));
    document.getElementById("livePublish").addEventListener("click", (event) => save(true, event.currentTarget));
  }

  function renderStudent() {
    const classes = model.classes || [];
    const chapters = model.chapters || [];
    const active = model.matches.filter((match) => match.status === "active").length;
    const joinAction = `<button class="button button-outline" id="liveJoinClass">＋ Join a class</button>`;
    root.innerHTML = `${header("STUDENT WORKSPACE", `Welcome, ${model.profile.display_name}`, classes.length ? "Your next chapter starts here." : "Join your class to get started.", `<button class="button button-outline" id="liveRefresh">Refresh</button>`)}
      ${classes.length ? renderRatingOverview() : ""}
      ${classes.length ? `<div class="stats-grid">${statCard("▤", chapters.length, "Published chapters")}${statCard("⚔", active, "Active matches")}${statCard("♙", new Set(model.members.map((member) => member.user_id)).size, "Classmates")}</div>` : ""}
      ${classes.length ? `<nav class="tab-bar" aria-label="Student workspace sections"><button class="tab-button active" data-live-tab="learn">Learn</button><button class="tab-button" data-live-tab="matches">Matches ${model.challenges.filter((item) => item.status === "pending" && item.opponent_id === model.userId).length ? "· new" : ""}</button><button class="tab-button" data-live-tab="classmates">Classmates</button><button class="tab-button" data-live-tab="history">History</button></nav>
        <section class="tab-panel active" data-live-panel="learn"><div class="section-heading"><div><h2>Available chapters</h2><p>Choose a classmate to start an ranked match.</p></div><span class="small">${chapters.length} available</span></div><div class="card-grid">${chapters.map(renderStudentChapter).join("") || `<div class="empty-state"><strong>No published chapters yet</strong>Your teacher's chapters will appear here when they are assigned to this class.</div>`}</div><div class="live-inline-action">${joinAction}</div></section>
        <section class="tab-panel" data-live-panel="matches">${renderStudentMatches()}</section>
        <section class="tab-panel" data-live-panel="classmates"><div class="section-heading"><div><h2>Classmates</h2><p>Invite a classmate from one of your published chapters to start a match.</p></div></div><div class="class-grid">${classes.map(renderStudentClass).join("")}</div></section>
        <section class="tab-panel" data-live-panel="history">${renderStudentHistory()}</section>`
        : `<section class="live-onboarding"><div class="live-onboarding-step">01</div><p class="eyebrow">JOIN YOUR CLASS</p><h2>Learn with your classmates</h2><p class="lede">Ask your teacher for the class code. Joining links your account to the class and unlocks its published chapters.</p><button class="button button-primary" id="liveJoinFirst">Enter class code <span aria-hidden="true">→</span></button><p class="small live-role-note">For teacher access, contact your school.</p></section>`}`;
    root.querySelector("#liveRefresh")?.addEventListener("click", () => refresh());
    root.querySelector("#liveJoinClass")?.addEventListener("click", openJoinModal);
    root.querySelector("#liveJoinFirst")?.addEventListener("click", openJoinModal);
    root.querySelectorAll("[data-live-challenge]").forEach((button) => button.addEventListener("click", () => openChallengePicker(button.dataset.liveChallenge)));
    root.querySelectorAll("[data-live-accept]").forEach((button) => button.addEventListener("click", () => acceptChallenge(button.dataset.liveAccept, button)));
    root.querySelectorAll("[data-live-cancel]").forEach((button) => button.addEventListener("click", () => cancelChallenge(button.dataset.liveCancel, button)));
    root.querySelectorAll("[data-live-match]").forEach((button) => button.addEventListener("click", () => openMatch(button.dataset.liveMatch)));
    root.querySelectorAll("[data-live-practice]").forEach((button) => button.addEventListener("click", () => startPractice(button.dataset.livePractice, button)));
    bindLiveTabs();
  }

  function renderStudentChapter(chapter) {
    const classIds = model.chapterLinks.filter((link) => link.chapter_id === chapter.id).map((link) => link.class_id);
    const classNames = model.classes.filter((classroom) => classIds.includes(classroom.id)).map((classroom) => classroom.name);
    const count = model.questionCounts[chapter.id] || 0;
    const used = model.matches.filter((match) => match.chapter_id === chapter.id && ["active", "completed", "forfeit", "no_contest"].includes(match.status)).length;
    return `<article class="surface-card set-card"><div class="set-card-top"><span class="subject-tag">${escape(chapter.subject || "General")}</span><span class="state-tag">${Math.max(0, 3 - used)} matches left</span></div><span class="set-icon" aria-hidden="true">✳</span><h3>${escape(chapter.title)}</h3><p class="set-meta">${count} questions${classNames.length ? ` · ${escape(classNames.join(" · "))}` : ""}</p><div class="set-card-footer"><div class="live-chapter-actions"><button class="button button-outline" data-live-practice="${escape(chapter.id)}">Practice</button><button class="button button-primary" data-live-challenge="${escape(chapter.id)}" ${used >= 3 ? "disabled" : ""}>Challenge →</button></div></div></article>`;
  }

  async function startPractice(chapterId, button) {
    const userId = model.userId;
    button.disabled = true;
    try {
      const chapter = model.chapters.find((item) => item.id === chapterId);
      const practiceRows = await rows(client.rpc('get_practice_questions', { p_chapter_id: chapterId }));
      if (!isCurrentUser(userId)) return;
      if (!practiceRows.length) return toast('This chapter has no questions to practise yet.');
      if (typeof window.scholaOpenQuiz !== 'function') throw new Error('The practice interface could not be loaded. Reload the page and try again.');
      const questions = practiceRows.map((question) => {
        const originalOptions = question.options;
        const order = [0, 1, 2, 3];
        for (let index = order.length - 1; index > 0; index -= 1) {
          const swapIndex = Math.floor(Math.random() * (index + 1));
          [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
        }
        return {
          text: question.prompt,
          options: order.map((optionIndex) => originalOptions[optionIndex]),
          correct: order.indexOf(Number(question.correct_option_index)),
          explanation: question.explanation || '',
        };
      });
      window.scholaOpenQuiz({
        title: chapter?.title || 'Chapter practice',
        questions,
        initialAnswers: Array(questions.length).fill(null),
        isPractice: true,
        onFinish: (answers) => {
          const correct = answers.reduce((total, answer, index) => total + (answer === questions[index].correct ? 1 : 0), 0);
          const review = questions.map((question, index) => {
            const isCorrect = answers[index] === question.correct;
            return `<div class='answer-review'><strong class='${isCorrect ? 'is-correct' : 'is-incorrect'}'>${isCorrect ? 'Correct' : 'Review'} · ${index + 1}. ${escape(question.text)}</strong><span>Answer: ${'ABCD'[question.correct]} · ${escape(question.options[question.correct])}${question.explanation ? ` · ${escape(question.explanation)}` : ''}</span></div>`;
          }).join('');
          openModal(`<div class='modal-header'><div><p class='eyebrow'>PRACTICE COMPLETE</p><h2 id='modalTitle'>Full chapter reviewed</h2></div><button class='button button-quiet' id='closePracticeResult' type='button'>Close</button></div><div class='result-score'>${correct}<span> / ${questions.length} correct</span></div><p class='modal-description'>Practice does not change ranked results or ratings.</p><div class='question-list'>${review}</div>`);
          document.getElementById('closePracticeResult').addEventListener('click', closeModal);
        },
      });
    } catch (error) {
      toast(errorMessage(error, 'Could not start practice.'));
    } finally {
      button.disabled = false;
    }
  }

  function renderStudentClass(classroom) {
    const memberIds = [...new Set(model.members.filter((member) => member.class_id === classroom.id).map((member) => member.user_id))];
    const people = memberIds.map((id) => model.people.find((person) => person.id === id)).filter(Boolean);
    return `<article class="surface-card class-card"><div class="class-card-head"><div><h3>${escape(classroom.name)}</h3><span class="small">${people.length} classmates</span></div><span class="class-chip">CLASS</span></div><div class="class-list">${people.map((person) => {
      const rating = model.ratings.find((item) => item.stream_id === classroom.stream_id && item.user_id === person.id)?.rating ?? 1000;
      return `<div class="player-block"><span class="avatar">${escape((person.display_name || "S").slice(0, 1).toUpperCase())}</span><div class="player-copy"><strong>${escape(person.display_name)}${person.id === model.userId ? " · you" : ""}</strong><span class="small">${person.role === "teacher" ? "Teacher" : "Student"}</span></div><span class="class-rating">${rating} <small>ELO</small></span></div>`;
    }).join("") || `<p class="small">Your classmates will appear here.</p>`}</div></article>`;
  }

  function renderStudentMatches() {
    const pending = model.challenges.filter((challenge) => challenge.status === "pending");
    const matches = model.matches.filter((match) => match.status === "active");
    const pendingMarkup = pending.length ? `<div class="section-heading"><div><h2>Invitations</h2><p>Challenges expire after three hours.</p></div></div><div class="live-list">${pending.map((challenge) => {
      const opponentId = challenge.challenger_id === model.userId ? challenge.opponent_id : challenge.challenger_id;
      const person = model.people.find((entry) => entry.id === opponentId);
      const chapter = model.chapters.find((entry) => entry.id === challenge.chapter_id);
      const expired = new Date(challenge.expires_at).getTime() <= Date.now();
      const action = expired ? `<span class="state-tag">Expired</span>` : challenge.opponent_id === model.userId
        ? `<button class="button button-secondary" data-live-accept="${escape(challenge.id)}">Accept</button>`
        : `<button class="button button-outline" data-live-cancel="${escape(challenge.id)}">Cancel</button>`;
      return `<article class="surface-card challenge-card"><div class="player-block"><span class="avatar">${escape((person?.display_name || "S").slice(0, 1).toUpperCase())}</span><div class="player-copy"><strong>${escape(person?.display_name || "Classmate")} · ${escape(chapter?.title || "Chapter")}</strong><span class="small">${challenge.opponent_id === model.userId ? "Invited you" : "Waiting for your classmate"} · expires ${new Date(challenge.expires_at).toLocaleString()}</span></div></div>${action}</article>`;
    }).join("")}</div>` : `<div class="empty-state"><strong>No open invitations</strong>Send a challenge from one of your chapters and it will appear here.</div>`;
    const matchesMarkup = matches.length ? `<div class="section-heading"><div><h2>Your matches</h2><p>Timed matches start when accepted. The timer keeps running if you leave.</p></div></div><div class="live-list">${matches.map((match) => {
      const opponentId = match.player_one_id === model.userId ? match.player_two_id : match.player_one_id;
      const person = model.people.find((entry) => entry.id === opponentId);
      const chapter = model.chapters.find((entry) => entry.id === match.chapter_id);
      const attempt = model.attempts.find((entry) => entry.match_id === match.id);
      const title = attempt?.submitted_at ? "Submitted · waiting for opponent" : `Your turn · due ${new Date(match.deadline_at).toLocaleString()}`;
      const button = attempt?.submitted_at
        ? `<button class="button button-outline" data-live-match="${escape(match.id)}">View status</button>`
        : `<button class="button button-primary" data-live-match="${escape(match.id)}">Play match</button>`;
      return `<article class="surface-card challenge-card"><div class="player-block"><span class="avatar ${match.status === "completed" ? "gold" : ""}">${escape((person?.display_name || "S").slice(0, 1).toUpperCase())}</span><div class="player-copy"><strong>${escape(person?.display_name || "Classmate")} · ${escape(chapter?.title || "Chapter")}</strong><span class="small">${escape(title)}</span></div></div>${button}</article>`;
    }).join("")}</div>` : `<div class="empty-state"><strong>No active matches</strong>Accepted matches will appear here until both students finish.</div>`;
    return `<div class="section-heading"><div><h2>Challenges and matches</h2><p>Invitations do not use a match until accepted.</p></div></div>${pendingMarkup}${matchesMarkup}`;
  }

  function renderStudentHistory() {
    const matches = model.matches.filter((match) => ["completed", "forfeit", "no_contest"].includes(match.status));
    const matchList = matches.length ? `<div class="live-list">${matches.map((match) => {
      const opponentId = match.player_one_id === model.userId ? match.player_two_id : match.player_one_id;
      const person = model.people.find((entry) => entry.id === opponentId);
      const chapter = model.chapters.find((entry) => entry.id === match.chapter_id);
      const attempt = model.attempts.find((entry) => entry.match_id === match.id);
      const title = match.status === "completed" ? (match.winner_id === model.userId ? "You won" : match.winner_id ? "Opponent won" : "Draw")
        : match.status === "forfeit" ? (match.winner_id === model.userId ? "Won by forfeit" : "Lost by forfeit") : "No contest";
      return `<article class="surface-card challenge-card"><div class="player-block"><span class="avatar ${match.status === "completed" ? "gold" : ""}">${escape((person?.display_name || "S").slice(0, 1).toUpperCase())}</span><div class="player-copy"><strong>${escape(chapter?.title || "Chapter")}</strong><span class="small">${escape(person?.display_name || "Classmate")} · ${escape(title)} · ${attempt?.submitted_at ? "Answers submitted" : "No submission"}</span></div></div><button class="button button-outline" data-live-match="${escape(match.id)}">${match.status === "completed" ? "View result" : "Details"}</button></article>`;
    }).join("")}</div>` : `<div class="empty-state"><strong>No completed matches yet</strong>Your results and answer reviews will appear here after a match ends.</div>`;
    return `<div class="section-heading"><div><h2>Match history</h2><p>Review completed matches and your submitted answers.</p></div></div>${matchList}`;
  }

  function openJoinModal() {
    openModal(`<div class="modal-header"><div><p class="eyebrow">CLASS INVITATION</p><h2 id="modalTitle">Join a class</h2></div><button class="button button-quiet" id="liveCloseJoin" type="button">Close</button></div><p class="modal-description">Enter the 12-character code from your teacher. Your account will be added to that class.</p><form id="liveJoinForm"><p id="joinMessage" role="status" aria-live="polite"></p><div class="field"><label for="liveJoinCode">Class code</label><input id="liveJoinCode" name="code" maxlength="20" autocomplete="off" placeholder="A1B2C3D4E5F6" required></div><div class="modal-footer"><span class="small">Signed in as ${escape(model.profile.display_name)}</span><button class="button button-primary" type="submit">Join class</button></div></form>`);
    document.getElementById("liveCloseJoin").addEventListener("click", closeModal);
    document.getElementById("liveJoinForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const code = form.elements.code.value.replace(/[\s-]/g, "").toUpperCase();
      const message = document.getElementById("joinMessage");
      if (!/^[A-F0-9]{12}$/.test(code)) { message.textContent = "Enter the 12-character class code from your teacher."; return; }
      const button = form.querySelector("button[type=submit]");
      button.disabled = true; button.textContent = "Joining...";
      form.setAttribute("aria-busy", "true");
      message.textContent = "Checking your class code...";
      try {
        const { data, error } = await client.rpc("join_class_by_code", { p_code: code });
        if (error) throw error;
        closeModal();
        toast(data.status === "already_member" ? `You're already in ${data.class_name}.` : `Joined ${data.class_name}.`);
        await refresh();
      } catch (error) {
        button.disabled = false;
        button.textContent = "Join class";
        form.removeAttribute("aria-busy");
        message.textContent = errorMessage(error, "Could not join this class. Check the code with your teacher and try again.");
      }
    });
  }

  function openChallengePicker(chapterId) {
    const chapterClassIds = new Set(model.chapterLinks.filter((link) => link.chapter_id === chapterId).map((link) => link.class_id));
    const peerIds = new Set(model.members.filter((member) => chapterClassIds.has(member.class_id) && member.user_id !== model.userId).map((member) => member.user_id));
    const peers = [...peerIds].map((id) => model.people.find((person) => person.id === id)).filter((person) => person?.role === "student");
    if (!peers.length) return toast("No other students have joined this chapter's classes yet.");
    const chapter = model.chapters.find((item) => item.id === chapterId);
    openModal(`<div class="modal-header"><div><p class="eyebrow">RANKED CHALLENGE</p><h2 id="modalTitle">Choose a classmate</h2></div><button class="button button-quiet" id="liveCloseChallenge" type="button">Close</button></div><p class="modal-description">Both students receive the same random set of questions, with answer choices shuffled separately.</p><form id="liveChallengeForm"><div class="field"><label for="liveOpponent">Opponent</label><select id="liveOpponent" name="opponent" required>${peers.map((person) => `<option value="${escape(person.id)}">${escape(person.display_name)}</option>`).join("")}</select></div><div class="modal-footer"><span class="small">${escape(chapter?.title || "Chapter")}</span><button class="button button-primary" type="submit">Send challenge</button></div></form>`);
    document.getElementById("liveCloseChallenge").addEventListener("click", closeModal);
    document.getElementById("liveChallengeForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const { error } = await client.rpc("create_challenge", { p_chapter_id: chapterId, p_opponent_id: event.currentTarget.elements.opponent.value });
        if (error) throw error;
        closeModal();
        toast("Challenge sent.");
        await refresh();
      } catch (error) {
        button.disabled = false;
        toast(errorMessage(error, "Could not send this challenge."));
      }
    });
  }

  async function acceptChallenge(challengeId, button) {
    const userId = model.userId;
    if (!window.confirm("Start the timed match now? Both players get one minute per question, with at least five minutes total. The shared timer starts immediately and cannot be paused. Make sure your classmate is ready.")) return;
    button.disabled = true;
    try {
      const { data, error } = await client.rpc("accept_challenge", { p_challenge_id: challengeId });
      if (error) throw error;
      const messages = {
        active: "Timed match started. The timer is running for both players.",
        accepted: "This invitation has already been accepted.",
        cancelled: "This invitation was cancelled.",
        expired: "This invitation has expired.",
        match_limit_reached: "One of the players has reached this chapter's match limit.",
      };
      toast(messages[data.status] || "This invitation is no longer available.");
      await refresh();
      if (data.status === "active" && data.match_id && isCurrentUser(userId)) await openMatch(data.match_id);
    } catch (error) {
      button.disabled = false;
      toast(errorMessage(error, "Could not accept this invitation."));
    }
  }

  async function cancelChallenge(challengeId, button) {
    button.disabled = true;
    try {
      const { error } = await client.rpc("cancel_challenge", { p_challenge_id: challengeId });
      if (error) throw error;
      toast("Invitation cancelled.");
      await refresh();
    } catch (error) {
      button.disabled = false;
      toast(errorMessage(error, "Could not cancel this invitation."));
    }
  }

  async function openMatch(matchId) {
    const userId = model.userId;
    try {
      const current = model.matches.find((match) => match.id === matchId);
      const { data: refreshed, error: refreshError } = await client.rpc("refresh_match", { p_match_id: matchId });
      const receivedAt = performance.now();
      if (refreshError) throw refreshError;
      if (!isCurrentUser(userId)) return;
      const match = { ...current, ...refreshed };
      const [questions, ownOrders, ownAttempt] = await Promise.all([
        rows(client.from("match_questions").select("id, position, prompt, options").eq("match_id", matchId).order("position")),
        rows(client.from("match_player_questions").select("match_question_id, display_order").eq("match_id", matchId).eq("user_id", model.userId)),
        one(client.from("match_attempts").select("answers, submitted_at").eq("match_id", matchId).eq("user_id", model.userId).maybeSingle()),
      ]);
      if (!isCurrentUser(userId)) return;
      if (match.status !== "active" || ownAttempt?.submitted_at) matchDraft(userId, matchId, null, null, null);
      if (match.status === "completed") return await showMatchResult(match, questions, ownOrders, ownAttempt);
      if (["forfeit", "no_contest"].includes(match.status)) return showMatchStatus(match);
      if (ownAttempt?.submitted_at) {
        openModal(`<div class="modal-header"><div><p class="eyebrow">MATCH</p><h2 id="modalTitle">Answers submitted</h2></div><button class="button button-quiet" id="closeMatchStatus" type="button">Close</button></div><p class="modal-description">Your answers have been saved. The result will appear after your classmate submits, or when the match deadline is reached.</p><div class="empty-state"><strong>Waiting for your opponent</strong>Match deadline: ${new Date(match.deadline_at).toLocaleString()}</div>`);
        document.getElementById("closeMatchStatus").addEventListener("click", closeModal);
        return;
      }
      const orderMap = Object.fromEntries(ownOrders.map((order) => [order.match_question_id, order.display_order]));
      const quizQuestions = questions.map((question) => {
        const order = orderMap[question.id] || [0, 1, 2, 3];
        return { text: question.prompt, options: order.map((index) => question.options[index]) };
      });
      const savedAnswers = Array.isArray(ownAttempt?.answers) ? ownAttempt.answers.map(Number) : [];
      const deadline = new Date(match.deadline_at).getTime();
      const fingerprint = JSON.stringify(questions.map((question) => [question.id, orderMap[question.id]]));
      const draftAnswers = matchDraft(userId, matchId, fingerprint, deadline);
      const initialAnswers = quizQuestions.map((question, index) => {
        const answer = savedAnswers[index] ?? draftAnswers[index];
        return Number.isInteger(answer) && answer >= 0 && answer < question.options.length ? answer : null;
      });
      if (typeof window.scholaOpenQuiz !== "function") throw new Error("The match interface could not be loaded. Reload the page and try again.");
      window.scholaOpenQuiz({
        title: model.chapters.find((chapter) => chapter.id === match.chapter_id)?.title || "Ranked match",
        questions: quizQuestions,
        initialAnswers,
        isPractice: false,
        deadlineAt: deadline,
        remainingMs: refreshed.server_now ? deadline - new Date(refreshed.server_now).getTime() - (performance.now() - receivedAt) : null,
        onExpire: async () => {
          if (isCurrentUser(userId)) await openMatch(matchId);
        },
        onChange: (answers) => {
          if (isCurrentUser(userId)) matchDraft(userId, matchId, fingerprint, deadline, answers);
        },
        onFinish: async (answers) => {
          if (!isCurrentUser(userId)) return;
          let response;
          try {
            response = await client.rpc("submit_match_answers", { p_match_id: matchId, p_answers: answers });
          } catch (error) {
            if (isCurrentUser(userId)) throw error;
            return;
          }
          if (!isCurrentUser(userId)) return;
          const { data, error } = response;
          if (error) return toast(errorMessage(error, "Could not submit your answers."));
          matchDraft(userId, matchId, null, null, null);
          closeModal();
          toast(["forfeit", "no_contest"].includes(data.status) ? "Time is up. Late answers were not accepted." : data.waiting_for_opponent ? "Answers submitted. Waiting for your opponent." : data.status === "completed" ? "Match complete. Results are ready." : "Answers submitted.");
          await refresh();
          if (isCurrentUser(userId) && ["completed", "forfeit", "no_contest"].includes(data.status)) await openMatch(matchId);
        },
      });
    } catch (error) {
      toast(errorMessage(error, "Could not open this match."));
    }
  }

  function showMatchStatus(match) {
    const wonByForfeit = match.status === "forfeit" && match.winner_id === model.userId;
    const title = match.status === "forfeit" ? (wonByForfeit ? "You won by forfeit" : "Match forfeited") : "No contest";
    const detail = match.status === "forfeit" ? (wonByForfeit ? "Your opponent did not submit before the deadline." : "You did not submit before the deadline.") : "Neither student submitted before the deadline.";
    openModal(`<div class="modal-header"><div><p class="eyebrow">MATCH RESULT</p><h2 id="modalTitle">${title}</h2></div><button class="button button-quiet" id="closeMatchStatus" type="button">Close</button></div><div class="empty-state"><strong>${title}</strong>${detail} These outcomes do not change ELO.</div>`);
    document.getElementById("closeMatchStatus").addEventListener("click", closeModal);
  }

  async function showMatchResult(match, questions, ownOrders, ownAttempt) {
    const userId = model.userId;
    const questionIds = questions.map((question) => question.id);
    const keys = questionIds.length
      ? await rows(client.from("match_question_keys").select("match_question_id, correct_option_index, explanation").in("match_question_id", questionIds))
      : [];
    if (!isCurrentUser(userId)) return;
    const orderMap = Object.fromEntries(ownOrders.map((item) => [item.match_question_id, item.display_order]));
    const keyMap = Object.fromEntries(keys.map((item) => [item.match_question_id, item]));
    const answers = Array.isArray(ownAttempt?.answers) ? ownAttempt.answers.map(Number) : [];
    const score = questions.reduce((total, question, index) => {
      const key = keyMap[question.id];
      const order = orderMap[question.id] || [];
      return total + (key && order[answers[index]] === key.correct_option_index ? 1 : 0);
    }, 0);
    const opponentId = match.player_one_id === model.userId ? match.player_two_id : match.player_one_id;
    const opponent = model.people.find((person) => person.id === opponentId);
    const rawOpponentScore = match.scores?.[opponentId];
    const opponentScore = Number.isInteger(rawOpponentScore) ? rawOpponentScore : null;
    const ratingChange = match.rating_changes?.[model.userId];
    const outcome = match.winner_id === model.userId ? "You won" : match.winner_id ? "Your classmate won" : "Draw";
    const review = questions.map((question, index) => {
      const key = keyMap[question.id];
      if (!key) return "";
      const correctOption = question.options[key.correct_option_index];
      const selectedIndex = orderMap[question.id]?.[answers[index]];
      const correct = selectedIndex === key.correct_option_index;
      return `<div class="answer-review"><strong class="${correct ? "is-correct" : "is-incorrect"}">${correct ? "Correct" : "Review"} · ${escape(question.prompt)}</strong><span>Answer: ${escape(correctOption)}${key.explanation ? ` · ${escape(key.explanation)}` : ""}</span></div>`;
    }).join("");
    openModal(`<div class="modal-header"><div><p class="eyebrow">MATCH COMPLETE</p><h2 id="modalTitle">${outcome}</h2></div><button class="button button-quiet" id="closeMatchResult" type="button">Close</button></div><div class="result-summary"><div class="result-stat"><strong>${score} / ${questions.length}</strong><span>Your correct answers</span></div><div class="result-stat"><strong>${opponentScore === null ? "—" : `${opponentScore} / ${questions.length}`}</strong><span>${escape(opponent?.display_name || "Opponent")} · correct answers</span></div></div>${ratingChange !== undefined ? `<div class="rating-summary"><strong>${Number(ratingChange) >= 0 ? "+" : ""}${Number(ratingChange)} ELO</strong><span>Rating updated</span></div>` : ""}<div class="question-list">${review}</div>`);
    document.getElementById("closeMatchResult").addEventListener("click", closeModal);
  }

  function reset() {
    if (model.userId) {
      try {
        Object.keys(localStorage).filter((key) => key.startsWith(`${draftPrefix}${model.userId}:`))
          .forEach((key) => localStorage.removeItem(key));
      } catch { /* Storage may be unavailable in private browsing. */ }
    }
    loadGeneration += 1;
    context = null;
    Object.keys(model).forEach((key) => { delete model[key]; });
    Object.assign(model, { userId: null, role: null, profile: null, loaded: false, loading: false, error: null, activeTab: null });
  }

  window.ScholaLiveApp = { render, refresh, reset };
})();
