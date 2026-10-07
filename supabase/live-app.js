(() => {
  const client = window.scholaSupabase;
  const root = document.getElementById("app");
  const model = { userId: null, role: null, profile: null, loaded: false, loading: false, error: null };
  let context = null;
  let loadGeneration = 0;

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const toast = (message) => window.scholaShowToast?.(message);
  const openModal = (html) => window.scholaOpenModal?.(html);
  const closeModal = () => window.scholaCloseModal?.();

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
    root.innerHTML = `${header("YOUR CLASSROOM", "Loading your workspace", "Getting your classes and chapters from Supabase.")}<div class="empty-state"><strong>One moment…</strong>Your account is being prepared.</div>`;
  }

  function errorView(error) {
    root.innerHTML = `${header("CONNECTION ISSUE", "We couldn't load your workspace", "Your account is still safe. Try loading the latest data again.")}<div class="empty-state"><strong>${escape(error?.message || "Supabase request failed.")}</strong><button class="button button-primary" id="liveRetry" type="button" style="margin-top:16px">Try again</button></div>`;
    root.querySelector("#liveRetry").addEventListener("click", () => refresh());
  }

  async function loadTeacherData(userId) {
    const streams = await rows(client.from("teacher_streams")
      .select("id, name, created_at").eq("owner_user_id", userId).order("created_at", { ascending: true }));
    if (!streams.length) return { streams, classes: [], chapters: [], assignments: [], invites: [], members: [], people: [] };
    const streamIds = streams.map((stream) => stream.id);
    const [classes, chapters] = await Promise.all([
      rows(client.from("classrooms").select("id, stream_id, name, created_at").in("stream_id", streamIds).order("created_at")),
      rows(client.from("chapters").select("id, stream_id, title, subject, published_at, created_at").in("stream_id", streamIds).order("created_at", { ascending: false })),
    ]);
    const classIds = classes.map((item) => item.id);
    const chapterIds = chapters.map((item) => item.id);
    const [assignments, invites, members, questionRows] = await Promise.all([
      chapterIds.length ? rows(client.from("chapter_classes").select("chapter_id, class_id").in("chapter_id", chapterIds)) : [],
      classIds.length ? rows(client.from("class_invites").select("code, class_id, expires_at").in("class_id", classIds).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false })) : [],
      classIds.length ? rows(client.from("class_members").select("class_id, user_id").in("class_id", classIds)) : [],
      chapterIds.length ? rows(client.from("chapter_questions").select("id, chapter_id").in("chapter_id", chapterIds)) : [],
    ]);
    const memberIds = [...new Set(members.map((member) => member.user_id))];
    const people = memberIds.length
      ? await rows(client.from("user_profiles").select("id, display_name, role").in("id", memberIds))
      : [];
    const questionCounts = Object.fromEntries(chapters.map((chapter) => [chapter.id, 0]));
    questionRows.forEach((question) => { questionCounts[question.chapter_id] = (questionCounts[question.chapter_id] || 0) + 1; });
    return { streams, classes, chapters, assignments, invites, members, people, questionCounts };
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
      rows(client.from("matches").select("id, chapter_id, stream_id, player_one_id, player_two_id, status, deadline_at, winner_id, forfeit_by, rating_changes, started_at")
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
    model.loading = true;
    model.loaded = false;
    model.error = null;
    loadingView();
    try {
      const data = model.role === "teacher" ? await loadTeacherData(userId) : await loadStudentData(userId);
      if (generation !== loadGeneration) return;
      Object.assign(model, data, { loaded: true, loading: false, error: null });
      renderBody();
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
        Object.assign(model, { userId, role, profile: context.profile, loaded: false, loading: false, error: null });
      } else {
        model.role = context.profile?.role;
        model.profile = context.profile;
      }
    }
    if (!context?.session?.user) return;
    if (!model.profile) {
      root.innerHTML = `${header("ACCOUNT SETUP", "Your profile is unavailable", "The Supabase session is active, but no profile row could be loaded.")}<div class="empty-state"><strong>${escape(context.profileError || "Ask the project administrator to check your account profile.")}</strong></div>`;
      return;
    }
    if (model.loading) return loadingView();
    if (model.error) return errorView(model.error);
    if (!model.loaded) return loadData();
    renderBody();
  }

  function renderBody() {
    if (model.role === "teacher") renderTeacher();
    else renderStudent();
  }

  function refresh() {
    if (!context?.session?.user) return;
    model.error = null;
    return loadData();
  }

  function bindLiveTabs() {
    const buttons = [...root.querySelectorAll("[data-live-tab]")];
    buttons.forEach((button) => button.addEventListener("click", () => {
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
    root.innerHTML = `${header("TEACHER WORKSPACE · LIVE DATA", `Welcome, ${model.profile.display_name}`, stream ? `Manage ${escape(stream.name)}. Changes save directly to Supabase.` : "Set up your teaching stream and classes to get started.", `<div class="live-header-actions"><button class="button button-outline" id="liveRefresh">Refresh</button>${createChapter}</div>`)}
      ${stream ? `<div class="live-hero"><div><p class="eyebrow">YOUR CLASSROOM</p><h2>${escape(stream.name)}</h2><p>One place for reviewed chapters, class invitations, and student progress.</p></div><div class="live-hero-mark" aria-hidden="true">✳</div></div>
        <div class="stats-grid">${statCard("▤", publishedCount, "Published chapters")}${statCard("♙", studentCount, "Students connected")}${statCard("▦", classCount, "Classes")}</div>
        <nav class="tab-bar" aria-label="Teacher workspace sections"><button class="tab-button active" data-live-tab="chapters">Chapters</button><button class="tab-button" data-live-tab="classes">Classes</button></nav>
        <section class="tab-panel active" data-live-panel="chapters"><div class="section-heading"><div><h2>Your chapters</h2><p>Drafts stay private. Published chapters are available to their assigned classes.</p></div><span class="small">${model.chapters.length} total</span></div><div class="card-grid">${model.chapters.map(renderTeacherChapter).join("") || `<div class="empty-state"><strong>No chapters yet</strong>Create a chapter or load the 15-question starter to publish your first lesson.</div>`}</div>${classCount ? "" : `<div class="empty-state"><strong>Add a class first</strong>Chapters need at least one class before they can be assigned.</div>`}</section>
        <section class="tab-panel" data-live-panel="classes"><div class="section-heading"><div><h2>Your classes</h2><p>Share a class code so students can join with their own account.</p></div><button class="button button-secondary" id="liveAddClass">＋ Add class</button></div><div class="class-grid">${model.classes.map(renderTeacherClass).join("") || `<div class="empty-state"><strong>No classes yet</strong>Add your first class to invite students and publish chapters.</div>`}</div></section>`
        : `<section class="live-onboarding"><div class="live-onboarding-step">01</div><p class="eyebrow">FIRST STEP</p><h2>Create your teaching space</h2><p class="lede">Name your stream and add your first classes. You can create invite codes for students as soon as the classes are saved.</p><button class="button button-primary" id="liveCreateStream">Create teaching space <span aria-hidden="true">→</span></button></section>`}`;

    root.querySelector("#liveRefresh")?.addEventListener("click", () => refresh());
    root.querySelector("#liveCreateChapter")?.addEventListener("click", () => openChapterEditor());
    root.querySelector("#liveCreateStream")?.addEventListener("click", () => openStreamEditor());
    root.querySelector("#liveAddClass")?.addEventListener("click", () => openClassEditor(stream));
    root.querySelectorAll("[data-edit-chapter]").forEach((button) => button.addEventListener("click", () => openChapterEditor(button.dataset.editChapter)));
    root.querySelectorAll("[data-new-invite]").forEach((button) => button.addEventListener("click", () => createInvite(button.dataset.newInvite, button)));
    root.querySelectorAll("[data-copy-invite]").forEach((button) => button.addEventListener("click", () => copyInvite(button.dataset.copyInvite)));
    bindLiveTabs();
  }

  function renderTeacherChapter(chapter) {
    const assignmentIds = model.assignments.filter((item) => item.chapter_id === chapter.id).map((item) => item.class_id);
    const names = model.classes.filter((item) => assignmentIds.includes(item.id)).map((item) => item.name);
    const published = Boolean(chapter.published_at);
    const count = model.questionCounts?.[chapter.id] || 0;
    return `<article class="surface-card set-card"><div class="set-card-top"><span class="subject-tag">${escape(chapter.subject || "General")}</span><span class="state-tag ${published ? "published" : ""}">${published ? "Published" : "Draft"}</span></div><span class="set-icon" aria-hidden="true">✳</span><h3>${escape(chapter.title)}</h3><p class="set-meta">${count} questions${names.length ? ` · ${escape(names.join(" · "))}` : ""}</p><div class="set-card-footer">${published ? `<span class="small">Live since ${new Date(chapter.published_at).toLocaleDateString()}</span>` : `<button class="button button-outline" data-edit-chapter="${escape(chapter.id)}">Continue draft →</button>`}</div></article>`;
  }

  function renderTeacherClass(classroom) {
    const memberIds = [...new Set(model.members.filter((member) => member.class_id === classroom.id).map((member) => member.user_id))];
    const people = memberIds.map((id) => model.people.find((person) => person.id === id)).filter(Boolean);
    const invite = model.invites.find((item) => item.class_id === classroom.id);
    const memberList = people.length
      ? `<div class="class-list">${people.slice(0, 5).map((person) => `<div class="player-block"><span class="avatar">${escape((person.display_name || "S").slice(0, 1).toUpperCase())}</span><div class="player-copy"><strong>${escape(person.display_name)}</strong><span class="small">Student account</span></div></div>`).join("")}${people.length > 5 ? `<p class="small">and ${people.length - 5} more students</p>` : ""}</div>`
      : `<div class="empty-state"><strong>No students yet</strong>Share the join code below to invite the class.</div>`;
    return `<article class="surface-card class-card"><div class="class-card-head"><div><h3>${escape(classroom.name)}</h3><span class="small">${people.length} ${people.length === 1 ? "student" : "students"}</span></div><span class="class-chip">CLASS</span></div>${memberList}<div class="live-invite-box">${invite ? `<div><span class="small">Class join code</span><strong class="live-code">${escape(invite.code.match(/.{1,4}/g).join(" "))}</strong><span class="small">Expires ${new Date(invite.expires_at).toLocaleDateString()}</span></div><button class="button button-outline" data-copy-invite="${escape(invite.code)}">Copy code</button>` : `<span class="small">Create a code to let students join.</span><button class="button button-secondary" data-new-invite="${escape(classroom.id)}">Create join code</button>`}</div></article>`;
  }

  function openStreamEditor() {
    openModal(`<div class="modal-header"><div><p class="eyebrow">LIVE CLASSROOM</p><h2 id="modalTitle">Create your teaching space</h2></div><button class="button button-quiet" id="liveCloseStream" type="button">Close</button></div><p class="modal-description">Give your teacher stream a name, then list your first classes separated by commas.</p><div class="field"><label for="liveStreamName">Stream name</label><input id="liveStreamName" maxlength="100" placeholder="For example, Marina's history classes" required></div><div class="field"><label for="liveClassNames">First classes</label><input id="liveClassNames" maxlength="500" placeholder="Grade 11A, Grade 11B" required></div><div class="modal-footer"><span class="small">Saved to Supabase</span><button class="button button-primary" id="liveSaveStream" type="button">Create stream</button></div>`);
    document.getElementById("liveCloseStream").addEventListener("click", closeModal);
    document.getElementById("liveSaveStream").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const name = document.getElementById("liveStreamName").value.trim();
      const classNames = document.getElementById("liveClassNames").value.split(",").map((item) => item.trim()).filter(Boolean);
      if (!name || !classNames.length) return toast("Add a stream name and at least one class.");
      if (classNames.length > 30) return toast("Add no more than 30 classes at once.");
      if (new Set(classNames.map((item) => item.toLocaleLowerCase())).size !== classNames.length) return toast("Class names must be unique.");
      button.disabled = true;
      try {
        const { error } = await client.rpc("create_teacher_space", { p_name: name, p_class_names: classNames });
        if (error) throw error;
        closeModal();
        toast("Teaching space created.");
        await refresh();
      } catch (error) {
        button.disabled = false;
        toast(error.message || "Could not create the teaching space.");
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
      button.disabled = true;
      try {
        await rows(client.from("classrooms").insert({ stream_id: stream.id, name }));
        closeModal();
        toast("Class added.");
        await refresh();
      } catch (error) {
        button.disabled = false;
        toast(error.message || "Could not add this class.");
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
      toast(error.message || "Could not create a class code.");
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
    const stream = model.streams[0];
    if (!stream || !model.classes.length) return toast("Create a class before building a chapter.");
    const existing = chapterId ? model.chapters.find((chapter) => chapter.id === chapterId) : null;
    let questions = [];
    if (existing) {
      try {
        const saved = await rows(client.from("chapter_questions").select("id, position, prompt, options").eq("chapter_id", existing.id).order("position"));
        const ids = saved.map((question) => question.id);
        const keys = ids.length ? await rows(client.from("question_answer_keys").select("question_id, correct_option_index, explanation").in("question_id", ids)) : [];
        const keyMap = Object.fromEntries(keys.map((key) => [key.question_id, key]));
        questions = saved.map((question) => ({
          prompt: question.prompt,
          options: question.options,
          correct: keyMap[question.id]?.correct_option_index ?? 0,
          explanation: keyMap[question.id]?.explanation || "",
        }));
      } catch (error) {
        return toast(error.message || "Could not load this draft.");
      }
    }
    const selected = new Set(model.assignments.filter((item) => item.chapter_id === chapterId).map((item) => item.class_id));
    const drawQuestions = () => {
      const list = document.getElementById("liveQuestionList");
      const count = document.getElementById("liveQuestionCount");
      const hint = document.getElementById("livePublishHint");
      if (!list || !count || !hint) return;
      count.textContent = `· ${questions.length}`;
      hint.textContent = questions.length >= 15 ? "Ready to publish" : `${15 - questions.length} more question${15 - questions.length === 1 ? "" : "s"} needed to publish`;
      list.innerHTML = questions.map((question, index) => `<div class="question-row"><div class="question-row-copy"><strong>${index + 1}. ${escape(question.prompt)}</strong><span>Correct: ${"ABCD"[question.correct]} · ${escape(question.options[question.correct])}</span></div><button class="button button-quiet" type="button" data-live-remove="${index}" aria-label="Remove question ${index + 1}">Remove</button></div>`).join("") || `<p class="small">Add questions here or load the starter set.</p>`;
      list.querySelectorAll("[data-live-remove]").forEach((button) => button.addEventListener("click", () => {
        questions.splice(Number(button.dataset.liveRemove), 1);
        drawQuestions();
      }));
    };
    openModal(`<div class="modal-header"><div><p class="eyebrow">LIVE CHAPTER</p><h2 id="modalTitle">${existing ? "Edit draft" : "Create a chapter"}</h2></div><button class="button button-quiet" id="liveCloseChapter" type="button">Close</button></div><p class="modal-description">Add four choices and a correct answer for each question. At least 15 complete questions are required to publish.</p><div class="form-grid"><div class="field"><label for="liveChapterTitle">Chapter title</label><input id="liveChapterTitle" maxlength="160" value="${escape(existing?.title || "")}" placeholder="For example, World War I" required></div><div class="field"><label for="liveChapterSubject">Subject</label><input id="liveChapterSubject" maxlength="100" value="${escape(existing?.subject || "")}" placeholder="History"></div></div><div class="field"><span class="field-label">Assign to classes</span><div class="live-check-list">${model.classes.map((classroom) => `<label><input type="checkbox" value="${escape(classroom.id)}" ${selected.has(classroom.id) || (!existing && model.classes.length === 1) ? "checked" : ""}><span>${escape(classroom.name)}</span></label>`).join("")}</div></div><div class="question-editor"><div class="live-editor-heading"><h3>Questions <span class="small" id="liveQuestionCount"></span></h3><button class="button button-outline" id="liveUseStarter" type="button">Use 15-question starter</button></div><div class="question-list" id="liveQuestionList"></div><h3>Add a question</h3><div class="field"><label for="livePrompt">Question</label><textarea id="livePrompt" rows="2" maxlength="2000" placeholder="Write a clear question"></textarea></div><div class="form-grid">${[0, 1, 2, 3].map((index) => `<div class="field"><label for="liveOption${index}">Option ${"ABCD"[index]}</label><input id="liveOption${index}" maxlength="500"></div>`).join("")}<div class="field"><label for="liveCorrect">Correct option</label><select id="liveCorrect"><option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option></select></div><div class="field"><label for="liveExplanation">Explanation (optional)</label><input id="liveExplanation" maxlength="4000"></div></div><button class="button button-secondary" id="liveAddQuestion" type="button">＋ Add question</button></div><div class="modal-footer"><span class="small" id="livePublishHint"></span><div class="modal-actions"><button class="button button-outline" id="liveSaveDraft" type="button">Save draft</button><button class="button button-primary" id="livePublish" type="button">${existing ? "Save and publish" : "Publish chapter"}</button></div></div>`);
    drawQuestions();
    document.getElementById("liveCloseChapter").addEventListener("click", closeModal);
    document.getElementById("liveUseStarter").addEventListener("click", () => {
      questions = (window.scholaSampleQuestions || []).map(([prompt, options, correct, explanation]) => ({ prompt, options: [...options], correct, explanation }));
      drawQuestions();
      toast("15 starter questions added. Review them before publishing.");
    });
    document.getElementById("liveAddQuestion").addEventListener("click", () => {
      const prompt = document.getElementById("livePrompt").value.trim();
      const options = [0, 1, 2, 3].map((index) => document.getElementById(`liveOption${index}`).value.trim());
      if (!prompt || options.some((option) => !option)) return toast("Add the question and all four answer choices.");
      questions.push({ prompt, options, correct: Number(document.getElementById("liveCorrect").value), explanation: document.getElementById("liveExplanation").value.trim() });
      ["livePrompt", "liveOption0", "liveOption1", "liveOption2", "liveOption3", "liveExplanation"].forEach((id) => { document.getElementById(id).value = ""; });
      drawQuestions();
      document.getElementById("livePrompt").focus();
    });
    const save = async (publish, button) => {
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
        questions.push({ prompt: pendingPrompt, options: pendingOptions, correct: Number(document.getElementById("liveCorrect").value), explanation: pendingExplanation });
        ["livePrompt", "liveOption0", "liveOption1", "liveOption2", "liveOption3", "liveExplanation"].forEach((id) => { document.getElementById(id).value = ""; });
        drawQuestions();
      }
      if (questions.length > 100) return toast("A chapter can contain no more than 100 questions.");
      if (publish && questions.length < 15) return toast("Add at least 15 questions before publishing.");
      if (publish && !window.confirm("Publish this chapter? Assigned students will be able to challenge one another on it.")) return;
      button.disabled = true;
      try {
        const { error } = await client.rpc("save_chapter", {
          p_stream_id: stream.id,
          p_chapter_id: existing?.id || null,
          p_title: title,
          p_subject: document.getElementById("liveChapterSubject").value.trim(),
          p_class_ids: classIds,
          p_questions: questions.map((question) => ({ prompt: question.prompt, options: question.options, correct_option_index: question.correct, explanation: question.explanation })),
          p_publish: publish,
        });
        if (error) throw error;
        closeModal();
        toast(publish ? "Chapter published to Supabase." : "Draft saved to Supabase.");
        await refresh();
      } catch (error) {
        button.disabled = false;
        toast(error.message || "Could not save this chapter.");
      }
    };
    document.getElementById("liveSaveDraft").addEventListener("click", (event) => save(false, event.currentTarget));
    document.getElementById("livePublish").addEventListener("click", (event) => save(true, event.currentTarget));
  }

  function renderStudent() {
    const classes = model.classes || [];
    const chapters = model.chapters || [];
    const active = model.matches.filter((match) => match.status === "active").length;
    const joinAction = `<button class="button button-outline" id="liveJoinClass">＋ Join a class</button>`;
    root.innerHTML = `${header("STUDENT WORKSPACE · LIVE DATA", `Welcome, ${model.profile.display_name}`, "Your classes, chapters, and ranked matches are connected to your account.", `<button class="button button-outline" id="liveRefresh">Refresh</button>`)}
      <div class="live-hero"><div><p class="eyebrow">YOUR LEARNING SPACE</p><h2>${classes.length ? `${classes.length} ${classes.length === 1 ? "class" : "classes"} connected` : "Start by joining your class"}</h2><p>${classes.length ? classes.map((classroom) => escape(classroom.name)).join(" · ") : "Enter the class code your teacher shared with you."}</p></div><div class="live-hero-mark" aria-hidden="true">✳</div></div>
      ${classes.length ? `<div class="stats-grid">${statCard("▤", chapters.length, "Published chapters")}${statCard("⚔", active, "Active matches")}${statCard("♙", new Set(model.members.map((member) => member.user_id)).size, "Classmates")}</div>` : ""}
      ${classes.length ? `<nav class="tab-bar" aria-label="Student workspace sections"><button class="tab-button active" data-live-tab="learn">Learn</button><button class="tab-button" data-live-tab="matches">Matches ${model.challenges.filter((item) => item.status === "pending" && item.opponent_id === model.userId).length ? "· new" : ""}</button><button class="tab-button" data-live-tab="classmates">Classmates</button></nav>
        <section class="tab-panel active" data-live-panel="learn"><div class="section-heading"><div><h2>Available chapters</h2><p>Choose a classmate to start an asynchronous ranked match.</p></div><span class="small">${chapters.length} available</span></div><div class="card-grid">${chapters.map(renderStudentChapter).join("") || `<div class="empty-state"><strong>No published chapters yet</strong>Your teacher's chapters will appear here when they are assigned to this class.</div>`}</div><div class="live-inline-action">${joinAction}</div></section>
        <section class="tab-panel" data-live-panel="matches">${renderStudentMatches()}</section>
        <section class="tab-panel" data-live-panel="classmates"><div class="section-heading"><div><h2>Classmates</h2><p>Invite a classmate from one of your published chapters to start a match.</p></div></div><div class="class-grid">${classes.map(renderStudentClass).join("")}</div></section>`
        : `<section class="live-onboarding"><div class="live-onboarding-step">01</div><p class="eyebrow">JOIN YOUR CLASS</p><h2>Learn with your classmates</h2><p class="lede">Ask your teacher for the class code. Joining links your account to the class and unlocks its published chapters.</p><button class="button button-primary" id="liveJoinFirst">Enter class code <span aria-hidden="true">→</span></button><p class="small live-role-note">New accounts are student accounts. A project administrator assigns teacher access.</p></section>`}`;
    root.querySelector("#liveRefresh")?.addEventListener("click", () => refresh());
    root.querySelector("#liveJoinClass")?.addEventListener("click", openJoinModal);
    root.querySelector("#liveJoinFirst")?.addEventListener("click", openJoinModal);
    root.querySelectorAll("[data-live-challenge]").forEach((button) => button.addEventListener("click", () => openChallengePicker(button.dataset.liveChallenge)));
    root.querySelectorAll("[data-live-accept]").forEach((button) => button.addEventListener("click", () => acceptChallenge(button.dataset.liveAccept, button)));
    root.querySelectorAll("[data-live-cancel]").forEach((button) => button.addEventListener("click", () => cancelChallenge(button.dataset.liveCancel, button)));
    root.querySelectorAll("[data-live-match]").forEach((button) => button.addEventListener("click", () => openMatch(button.dataset.liveMatch)));
    bindLiveTabs();
  }

  function renderStudentChapter(chapter) {
    const classIds = model.chapterLinks.filter((link) => link.chapter_id === chapter.id).map((link) => link.class_id);
    const classNames = model.classes.filter((classroom) => classIds.includes(classroom.id)).map((classroom) => classroom.name);
    const count = model.questionCounts[chapter.id] || 0;
    const used = model.matches.filter((match) => match.chapter_id === chapter.id && ["active", "completed", "forfeit", "no_contest"].includes(match.status)).length;
    return `<article class="surface-card set-card"><div class="set-card-top"><span class="subject-tag">${escape(chapter.subject || "General")}</span><span class="state-tag">${Math.max(0, 3 - used)} matches left</span></div><span class="set-icon" aria-hidden="true">✳</span><h3>${escape(chapter.title)}</h3><p class="set-meta">${count} questions${classNames.length ? ` · ${escape(classNames.join(" · "))}` : ""}</p><div class="set-card-footer"><span class="small">Available to your class</span><button class="button button-primary" data-live-challenge="${escape(chapter.id)}" ${used >= 3 ? "disabled" : ""}>Challenge →</button></div></article>`;
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
    const matches = model.matches;
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
    const matchesMarkup = matches.length ? `<div class="section-heading"><div><h2>Your matches</h2><p>Answer before the 24-hour deadline. Your opponent can play later.</p></div></div><div class="live-list">${matches.map((match) => {
      const opponentId = match.player_one_id === model.userId ? match.player_two_id : match.player_one_id;
      const person = model.people.find((entry) => entry.id === opponentId);
      const chapter = model.chapters.find((entry) => entry.id === match.chapter_id);
      const attempt = model.attempts.find((entry) => entry.match_id === match.id);
      const title = match.status === "active" ? (attempt?.submitted_at ? "Submitted · waiting for opponent" : `Your turn · due ${new Date(match.deadline_at).toLocaleString()}`)
        : match.status === "completed" ? (match.winner_id === model.userId ? "Completed · you won" : match.winner_id ? "Completed · opponent won" : "Completed · draw")
          : match.status === "forfeit" ? (match.winner_id === model.userId ? "Won by forfeit" : "Lost by forfeit") : "No contest";
      const button = match.status === "active" && !attempt?.submitted_at
        ? `<button class="button button-primary" data-live-match="${escape(match.id)}">Play match</button>`
        : `<button class="button button-outline" data-live-match="${escape(match.id)}">${match.status === "completed" ? "View result" : match.status === "active" ? "View status" : "Details"}</button>`;
      return `<article class="surface-card challenge-card"><div class="player-block"><span class="avatar ${match.status === "completed" ? "gold" : ""}">${escape((person?.display_name || "S").slice(0, 1).toUpperCase())}</span><div class="player-copy"><strong>${escape(person?.display_name || "Classmate")} · ${escape(chapter?.title || "Chapter")}</strong><span class="small">${escape(title)}</span></div></div>${button}</article>`;
    }).join("")}</div>` : `<div class="empty-state"><strong>No matches yet</strong>Challenge a classmate from an available chapter to start one.</div>`;
    return `<div class="section-heading"><div><h2>Challenges and matches</h2><p>Invitations do not use a match until accepted.</p></div></div>${pendingMarkup}${matchesMarkup}`;
  }

  function openJoinModal() {
    openModal(`<div class="modal-header"><div><p class="eyebrow">CLASS INVITATION</p><h2 id="modalTitle">Join a class</h2></div><button class="button button-quiet" id="liveCloseJoin" type="button">Close</button></div><p class="modal-description">Enter the 12-character code from your teacher. Your account will be added to that class.</p><form id="liveJoinForm"><div class="field"><label for="liveJoinCode">Class code</label><input id="liveJoinCode" name="code" maxlength="20" autocomplete="off" placeholder="A1B2C3D4E5F6" required></div><div class="modal-footer"><span class="small">Signed in as ${escape(model.profile.display_name)}</span><button class="button button-primary" type="submit">Join class</button></div></form>`);
    document.getElementById("liveCloseJoin").addEventListener("click", closeModal);
    document.getElementById("liveJoinForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const { data, error } = await client.rpc("join_class_by_code", { p_code: event.currentTarget.elements.code.value.trim() });
        if (error) throw error;
        closeModal();
        toast(data.status === "already_member" ? `You're already in ${data.class_name}.` : `Joined ${data.class_name}.`);
        await refresh();
      } catch (error) {
        button.disabled = false;
        toast(error.message || "Could not join this class.");
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
        toast(error.message || "Could not send this challenge.");
      }
    });
  }

  async function acceptChallenge(challengeId, button) {
    button.disabled = true;
    try {
      const { data, error } = await client.rpc("accept_challenge", { p_challenge_id: challengeId });
      if (error) throw error;
      toast(data.status === "active" ? "Match accepted. You have 24 hours to submit." : `Invitation status: ${data.status}.`);
      await refresh();
    } catch (error) {
      button.disabled = false;
      toast(error.message || "Could not accept this invitation.");
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
      toast(error.message || "Could not cancel this invitation.");
    }
  }

  async function openMatch(matchId) {
    try {
      const current = model.matches.find((match) => match.id === matchId);
      const { data: refreshed, error: refreshError } = await client.rpc("refresh_match", { p_match_id: matchId });
      if (refreshError) throw refreshError;
      const match = { ...current, ...refreshed };
      const [questions, ownOrders, ownAttempt] = await Promise.all([
        rows(client.from("match_questions").select("id, position, prompt, options").eq("match_id", matchId).order("position")),
        rows(client.from("match_player_questions").select("match_question_id, display_order").eq("match_id", matchId).eq("user_id", model.userId)),
        one(client.from("match_attempts").select("answers, submitted_at").eq("match_id", matchId).eq("user_id", model.userId).maybeSingle()),
      ]);
      if (match.status === "completed") return showMatchResult(match, questions, ownOrders, ownAttempt);
      if (["forfeit", "no_contest"].includes(match.status)) return showMatchStatus(match);
      if (ownAttempt?.submitted_at) {
        openModal(`<div class="modal-header"><div><p class="eyebrow">ASYNC MATCH</p><h2 id="modalTitle">Answers submitted</h2></div><button class="button button-quiet" id="closeMatchStatus" type="button">Close</button></div><p class="modal-description">Your answers are saved in Supabase. The result will appear after your classmate submits, or when the match deadline is reached.</p><div class="empty-state"><strong>Waiting for your opponent</strong>Match deadline: ${new Date(match.deadline_at).toLocaleString()}</div>`);
        document.getElementById("closeMatchStatus").addEventListener("click", closeModal);
        return;
      }
      const orderMap = Object.fromEntries(ownOrders.map((order) => [order.match_question_id, order.display_order]));
      const quizQuestions = questions.map((question) => {
        const order = orderMap[question.id] || [0, 1, 2, 3];
        return { text: question.prompt, options: order.map((index) => question.options[index]) };
      });
      const savedAnswers = Array.isArray(ownAttempt?.answers) ? ownAttempt.answers.map(Number) : [];
      const initialAnswers = quizQuestions.map((_, index) => Number.isInteger(savedAnswers[index]) ? savedAnswers[index] : null);
      if (typeof window.scholaOpenQuiz !== "function") throw new Error("The match interface could not be loaded. Reload the page and try again.");
      window.scholaOpenQuiz({
        title: model.chapters.find((chapter) => chapter.id === match.chapter_id)?.title || "Ranked match",
        questions: quizQuestions,
        initialAnswers,
        isPractice: false,
        deadlineAt: new Date(match.deadline_at).getTime(),
        onFinish: async (answers) => {
          const { data, error } = await client.rpc("submit_match_answers", { p_match_id: matchId, p_answers: answers });
          if (error) return toast(error.message || "Could not submit your answers.");
          closeModal();
          toast(data.waiting_for_opponent ? "Answers submitted. Waiting for your opponent." : data.status === "completed" ? "Match complete. Results are ready." : "Answers submitted.");
          await refresh();
          if (data.status === "completed") openMatch(matchId);
        },
      });
    } catch (error) {
      toast(error.message || "Could not open this match.");
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
    const questionIds = questions.map((question) => question.id);
    const keys = questionIds.length
      ? await rows(client.from("match_question_keys").select("match_question_id, correct_option_index, explanation").in("match_question_id", questionIds))
      : [];
    const orderMap = Object.fromEntries(ownOrders.map((item) => [item.match_question_id, item.display_order]));
    const keyMap = Object.fromEntries(keys.map((item) => [item.match_question_id, item]));
    const answers = Array.isArray(ownAttempt?.answers) ? ownAttempt.answers.map(Number) : [];
    const score = questions.reduce((total, question, index) => {
      const key = keyMap[question.id];
      const order = orderMap[question.id] || [];
      return total + (key && order[answers[index]] === key.correct_option_index ? 1 : 0);
    }, 0);
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
    openModal(`<div class="modal-header"><div><p class="eyebrow">MATCH COMPLETE</p><h2 id="modalTitle">${outcome}</h2></div><button class="button button-quiet" id="closeMatchResult" type="button">Close</button></div><div class="result-score">${score}<span> / ${questions.length} correct</span></div>${ratingChange !== undefined ? `<div class="rating-summary"><strong>${Number(ratingChange) >= 0 ? "+" : ""}${Number(ratingChange)} ELO</strong><span>Updated in your teacher stream</span></div>` : ""}<div class="question-list">${review}</div>`);
    document.getElementById("closeMatchResult").addEventListener("click", closeModal);
  }

  window.ScholaLiveApp = { render, refresh };
})();
