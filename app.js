const ANSWER_LABELS = ["A", "B", "C", "D"];
const app = document.getElementById("app");
const roleBadge = document.getElementById("roleBadge");
const modalBackdrop = document.getElementById("modalBackdrop");
const modal = document.getElementById("modal");
const accountStatus = document.getElementById("accountStatus");
const authButton = document.getElementById("authButton");
const supabaseClient = window.scholaSupabase;
let accountSession = null;
let accountProfile = null;
let accountIssue = null;
let accountReady = false;
let accountMode = "signin";
let authRequestVersion = 0;
let confirmationRequestedAt = 0;
const authLinkParams = new URLSearchParams(location.hash.slice(1));
let recoveringPassword = authLinkParams.get("type") === "recovery";
if (authLinkParams.has("error")) {
  accountMode = "reset";
  accountIssue = "This sign-in link is invalid or expired. Request a new password reset link.";
  history.replaceState(null, "", location.pathname + location.search);
}
const accountButton = document.createElement("button");
accountButton.id = "accountButton";
accountButton.className = "button button-outline";
accountButton.textContent = "My account";
accountButton.hidden = true;
authButton.before(accountButton);
accountButton.addEventListener("click", openAccountEditor);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function userErrorMessage(error, fallback = "Something went wrong. Please try again.") {
  window.scholaReportError?.("account", error);
  const messages = {
    invalid_credentials: "The email or password is incorrect.",
    email_not_confirmed: "Confirm your email before signing in.",
    user_already_exists: "An account with this email already exists. Sign in instead.",
    signup_disabled: "Registration is currently unavailable. Please try again later.",
    over_request_rate_limit: "Too many attempts. Please wait a moment and try again.",
    over_email_send_rate_limit: "Please wait a moment before requesting another email.",
    weak_password: "Choose a stronger password with at least 8 characters.",
    session_not_found: "Your session has ended. Please sign in again.",
  };
  if (messages[error?.code]) return messages[error.code];
  const message = typeof error?.message === "string" ? error.message : "";
  if (!message || error?.status >= 500 || /supabase|postgrest|schema|database|sql|rpc|jwt|row.level|relation|constraint|column|function|permission denied|fetch|network|json|profile row|api key|is not defined|cannot read|unexpected token/i.test(message)) return fallback;
  return message.replace(/teacher stream/gi, "teaching space").replace(/\bstream\b/gi, "teaching space");
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

function statCard(icon, value, label) {
  return `<article class="stat-card"><span class="stat-icon" aria-hidden="true">${escapeHtml(icon)}</span><div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div></div></article>`;
}

let quizCleanup = null;
let modalLifecycle = null;
let modalReturnFocus = null;

window.addEventListener("beforeunload", (event) => {
  modalLifecycle?.flush?.();
  if (modalLifecycle?.dirty?.()) { event.preventDefault(); event.returnValue = ""; }
});

function openModal(html) {
  if (!accountSession || !accountProfile) return false;
  if (modalLifecycle && !closeModal()) return false;
  if (!modalBackdrop.classList.contains("show")) modalReturnFocus = document.activeElement;
  quizCleanup?.();
  quizCleanup = null;
  modal.innerHTML = html;
  modalBackdrop.classList.add("show");
  modalBackdrop.setAttribute("aria-hidden", "false");
  modal.querySelector("button, input, select")?.focus();
  return true;
}

function closeModal(force = false) {
  if (force !== true && modalLifecycle?.busy?.()) { showToast("Saving the chapter. Please wait."); return false; }
  modalLifecycle?.flush?.();
  if (force !== true && modalLifecycle?.dirty?.() && !window.confirm(modalLifecycle.closeMessage?.() || "Close the chapter editor? Your unsaved draft is kept on this device. You can restore it when you reopen the chapter.")) return false;
  modalLifecycle?.cleanup?.();
  modalLifecycle = null;
  quizCleanup?.();
  quizCleanup = null;
  modalBackdrop.classList.remove("show");
  modalBackdrop.setAttribute("aria-hidden", "true");
  modal.innerHTML = "";
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
  return true;
}

function formatTimeRemaining(deadlineAt) {
  return formatRemainingTime(deadlineAt - Date.now());
}

function formatRemainingTime(milliseconds) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function paintAccountStatus() {
  accountStatus.textContent = !supabaseClient ? "Connection unavailable"
    : !accountReady ? "Connecting" : accountSession ? "Connected" : "Sign in to continue";
  accountStatus.title = accountProfile ? `Signed in as ${accountProfile.display_name}` : "";
  accountButton.hidden = !accountProfile || recoveringPassword;
  roleBadge.hidden = !accountProfile;
  roleBadge.textContent = accountProfile?.role === "teacher" ? "Teacher" : "Student";
  authButton.textContent = accountSession ? "Sign out" : "Sign in";
  authButton.disabled = !supabaseClient || !accountReady;
}

function accountProblem(title, message) {
  app.innerHTML = `<section class="account-screen"><p class="eyebrow">YOUR ACCOUNT</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(message)}</p><button class="button button-primary account-retry" id="retryAccount" type="button">Try again</button></section>`;
  document.getElementById("retryAccount").addEventListener("click", () => {
    if (supabaseClient) refreshAccount();
    else window.location.reload();
  });
}

function render() {
  paintAccountStatus();
  if (!supabaseClient) {
    accountProblem("We couldn't connect", "Check your internet connection and try again.");
    return;
  }
  if (!accountReady) {
    app.innerHTML = '<section class="account-screen"><p class="eyebrow">YOUR ACCOUNT</p><h1>Getting things ready</h1><p class="lede" role="status">Checking your sign-in...</p></section>';
    return;
  }
  if (recoveringPassword && accountSession) { renderPasswordForm(); return; }
  if (!accountSession) {
    renderAccountForm();
    return;
  }
  if (!accountProfile) {
    accountProblem("We couldn't load your account", accountIssue || "Please try again. Contact your school if the problem continues.");
    return;
  }
  window.ScholaLiveApp.render({ session: accountSession, profile: accountProfile });
}

async function refreshAccount(session = undefined) {
  if (!supabaseClient) return render();
  const version = ++authRequestVersion;
  let nextSession = session;
  try {
    if (nextSession === undefined) {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      nextSession = data.session;
    }
    if (version !== authRequestVersion) return;
    if (accountSession?.user?.id !== nextSession?.user?.id) {
      closeModal(true);
      window.ScholaLiveApp?.reset();
    }
    accountSession = nextSession;
    window.scholaSetDiagnosticUser?.(nextSession?.user?.id || null);
    accountProfile = null;
    accountIssue = authLinkParams.has("error") && !nextSession ? "This sign-in link is invalid or expired. Request a new password reset link." : null;
    if (nextSession?.user) {
      const { data, error } = await supabaseClient.from("user_profiles")
        .select("display_name, role").eq("id", nextSession.user.id).maybeSingle();
      if (version !== authRequestVersion) return;
      if (error) throw error;
      accountProfile = data;
    }
  } catch (error) {
    if (version !== authRequestVersion) return;
    accountIssue = userErrorMessage(error, "We couldn't load your account. Please try again.");
  }
  accountReady = true;
  render();
}

function renderAccountForm() {
  const signingUp = accountMode === "signup";
  const resetting = accountMode === "reset";
  app.innerHTML = `<section class="account-screen"><p class="eyebrow">SCHOLA CLASH</p><h1>${resetting ? "Reset your password" : signingUp ? "Create your account" : "Sign in"}</h1><p class="lede">${resetting ? "Enter your email to receive a link to choose a new password." : signingUp ? "Students join with a class code. Teachers: ask your school to enable teacher access after registration." : "Continue to your classes and chapters."}</p><form id="authForm" class="account-form">
    ${signingUp ? '<div class="field"><label for="authName">Your name</label><input id="authName" name="displayName" autocomplete="name" maxlength="80" required></div>' : ""}
    <div class="field"><label for="authEmail">Email</label><input id="authEmail" name="email" type="email" autocomplete="email" required></div>
    ${resetting ? "" : `<div class="field"><label for="authPassword">Password</label><input id="authPassword" name="password" type="password" autocomplete="${signingUp ? "new-password" : "current-password"}" minlength="8" required></div>`}
    <p class="account-message small" id="authMessage" role="status" aria-live="polite">${escapeHtml(accountIssue || "")}</p>
    <button class="button button-primary account-submit" type="submit">${resetting ? "Send reset link" : signingUp ? "Create account" : "Sign in"}</button>
    ${!signingUp && !resetting ? '<button class="account-switch" type="button" id="forgotPassword">Forgot password?</button>' : ""}
    <button class="account-switch" type="button" id="toggleAuthMode">${resetting || signingUp ? "Already have an account? Sign in" : "New here? Create an account"}</button>
    ${!resetting ? '<button class="account-switch" type="button" id="resendConfirmation">Resend confirmation email</button>' : ""}
  </form></section>`;
  document.getElementById("forgotPassword")?.addEventListener("click", () => {
    const email = document.getElementById("authEmail").value;
    accountMode = "reset"; accountIssue = null; renderAccountForm();
    document.getElementById("authEmail").value = email;
    document.getElementById("authEmail").focus();
  });
  document.getElementById("resendConfirmation")?.addEventListener("click", async (event) => {
    const email = document.getElementById("authEmail");
    const message = document.getElementById("authMessage");
    if (!email.reportValidity()) return;
    if (Date.now() - confirmationRequestedAt < 60000) { message.textContent = "Wait a minute before requesting another confirmation email."; return; }
    const button = event.currentTarget;
    button.disabled = true;
    message.textContent = "Sending confirmation email...";
    try {
      const { error } = await supabaseClient.auth.resend({ type: "signup", email: email.value.trim(), options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      confirmationRequestedAt = Date.now();
      message.textContent = "If this account needs confirmation, a new link is on its way. Check your inbox and spam folder.";
    } catch (error) { message.textContent = userErrorMessage(error, "Could not send the confirmation email. Please try again."); }
    finally { button.disabled = false; }
  });
  document.getElementById("toggleAuthMode").addEventListener("click", () => {
    accountMode = signingUp || resetting ? "signin" : "signup";
    accountIssue = null;
    renderAccountForm();
    document.getElementById(signingUp || resetting ? "authEmail" : "authName").focus();
  });
  document.getElementById("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const message = document.getElementById("authMessage");
    const email = form.elements.email.value.trim();
    if (signingUp && !form.elements.displayName.value.trim()) { message.textContent = "Enter your name."; return; }
    const switches = form.querySelectorAll('button[type="button"]');
    switches.forEach((button) => button.disabled = true);
    submit.disabled = true;
    form.setAttribute("aria-busy", "true");
    message.textContent = resetting ? "Sending reset link..." : signingUp ? "Creating your account..." : "Signing in...";
    try {
      if (resetting) {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        if (error) throw error;
        message.textContent = "If an account exists for " + email + ", a reset link is on its way. Check your inbox and spam folder.";
        return;
      }
      const result = signingUp
        ? await supabaseClient.auth.signUp({ email, password: form.elements.password.value,
          options: { data: { display_name: form.elements.displayName.value.trim() } } })
        : await supabaseClient.auth.signInWithPassword({ email, password: form.elements.password.value });
      if (result.error) throw result.error;
      if (signingUp && !result.data.session) {
        message.textContent = `Check ${email} for a confirmation link, then sign in.`;
        return;
      }
      if (!result.data.session) throw new Error("Please try signing in again.");
      await refreshAccount(result.data.session);
      showToast(signingUp ? "Account created." : "Signed in.");
    } catch (error) {
      message.textContent = userErrorMessage(error, resetting ? "We couldn't send the reset link. Please try again." : signingUp ? "We couldn't create your account. Please try again." : "We couldn't sign you in. Please try again.");
    } finally {
      submit.disabled = false;
      form.removeAttribute("aria-busy");
      switches.forEach((button) => button.disabled = false);
    }
  });
}

function renderPasswordForm() {
  app.innerHTML = `<section class="account-screen"><p class="eyebrow">YOUR ACCOUNT</p><h1>Choose a new password</h1><p class="lede">Use at least 8 characters.</p><form id="passwordForm" class="account-form"><div class="field"><label for="newPassword">New password</label><input id="newPassword" name="password" type="password" autocomplete="new-password" minlength="8" required></div><div class="field"><label for="confirmPassword">Confirm new password</label><input id="confirmPassword" name="confirmation" type="password" autocomplete="new-password" minlength="8" required></div><p id="passwordMessage" role="status" aria-live="polite"></p><button class="button button-primary" type="submit">Save password</button></form></section>`;
  document.getElementById("passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, message = document.getElementById("passwordMessage");
    if (form.elements.password.value !== form.elements.confirmation.value) { message.textContent = "Passwords do not match."; return; }
    const button = form.querySelector("button"); button.disabled = true;
    form.setAttribute("aria-busy", "true"); message.textContent = "Saving your password...";
    try {
      const { error } = await supabaseClient.auth.updateUser({ password: form.elements.password.value });
      if (error) throw error;
      recoveringPassword = false;
      history.replaceState(null, "", location.pathname + location.search);
      await refreshAccount(); showToast("Password updated.");
    } catch (error) {
      message.textContent = userErrorMessage(error, "Could not save your password. Request a new reset link if this one has expired.");
    } finally { button.disabled = false; form.removeAttribute("aria-busy"); }
  });
}
function openAccountEditor() {
  const userId = accountSession?.user.id;
  if (!userId || !accountProfile) return;
  if (modalLifecycle && !closeModal()) return;
  openModal(`<div class="modal-header"><h2 id="modalTitle">My account</h2><button class="button button-quiet" id="closeAccount" type="button">Close</button></div><form id="accountForm"><div class="field"><label for="displayName">Your name</label><input id="displayName" name="displayName" value="${escapeHtml(accountProfile.display_name)}" autocomplete="name" maxlength="80" required></div><p class="small">${escapeHtml(accountSession.user.email || "")} · ${escapeHtml(accountProfile.role)}</p><p id="accountMessage" role="status" aria-live="polite"></p><div class="modal-footer"><button class="button button-primary" type="submit">Save name</button></div></form>`);
  document.getElementById("closeAccount").addEventListener("click", closeModal);
  window.ScholaAccountActions?.mount({ client: supabaseClient, session: accountSession, profile: accountProfile, host: modal });
  document.getElementById("accountForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, message = document.getElementById("accountMessage"), name = form.elements.displayName.value.trim();
    if (!name) { message.textContent = "Enter your name."; return; }
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    form.setAttribute("aria-busy", "true"); message.textContent = "Saving your name...";
    try {
      const { data, error } = await supabaseClient.from("user_profiles").update({ display_name: name }).eq("id", userId).select("display_name, role").single();
      if (error) throw error;
      if (accountSession?.user.id !== userId) return;
      accountProfile = data;
      if (form.isConnected) closeModal();
      render(); showToast("Name updated.");
    } catch (error) { message.textContent = userErrorMessage(error, "Could not save your name. Please try again."); }
    finally { button.disabled = false; form.removeAttribute("aria-busy"); }
  });
}

authButton.addEventListener("click", async () => {
  if (!accountSession) {
    document.getElementById("authEmail")?.focus();
    return;
  }
  authButton.disabled = true;
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    recoveringPassword = false; accountMode = "signin";
    await refreshAccount(null);
    showToast("Signed out.");
  } catch (error) {
    showToast(userErrorMessage(error, "We couldn't sign you out. Please try again."));
    paintAccountStatus();
  }
});

modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalBackdrop.classList.contains("show")) closeModal();
  if (event.key === "Tab" && modalBackdrop.classList.contains("show")) {
    const focusable = [...modal.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
      .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first) { event.preventDefault(); modal.focus(); return; }
    if (!modal.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)
      || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  }
});

function openQuiz({ title, questions, initialAnswers, isPractice, deadlineAt = null, remainingMs = null, onChange, onExpire, onFinish }) {
  const answers = [...initialAnswers];
  let submitting = false;
  const timed = !isPractice && deadlineAt !== null;
  const endsAt = performance.now() + (remainingMs ?? deadlineAt - Date.now());
  let expiryHandled = false;
  const timeIsUp = () => timed && performance.now() >= endsAt;
  const tick = () => {
    const label = document.getElementById("matchDeadline");
    if (!label || !timed) return;
    label.textContent = timeIsUp() ? "Time is up" : `Time left ${formatRemainingTime(endsAt - performance.now())}`;
    if (!timeIsUp()) return;
    modal.querySelectorAll(".answer-option, #previousQuestion, #nextQuestion").forEach((button) => { button.disabled = true; });
    if (!submitting && !expiryHandled) {
      expiryHandled = true;
      Promise.resolve().then(() => onExpire?.()).catch((error) => showToast(userErrorMessage(error, "Time is up. Reopen the match to see its result.")));
    }
  };
  let index = Math.max(0, answers.findIndex((answer) => answer === null));
  const paint = () => {
    const question = questions[index];
    modal.innerHTML = `<div class="modal-header"><div><p class="eyebrow">${isPractice ? "PRACTICE MODE" : "RANKED MATCH"}</p><h2 id="modalTitle">${escapeHtml(title)}</h2></div><button class="button button-quiet" id="leaveQuiz" aria-label="Close quiz">✕</button></div><div class="quiz-progress-head"><span>Question ${index + 1} of ${questions.length}</span><span id="matchDeadline" data-deadline="${deadlineAt || ""}">${isPractice ? "No rating" : deadlineAt ? `Due in ${formatTimeRemaining(deadlineAt)}` : "Ranked match"}</span></div><div class="progress-track" style="margin-top:9px"><div class="progress-fill" style="width:${(index + 1) / questions.length * 100}%"></div></div><h3 class="quiz-question">${escapeHtml(question.text)}</h3><div class="answer-list">${question.options.map((option, optionIndex) => `<button class="answer-option ${answers[index] === optionIndex ? "selected" : ""}" data-answer="${optionIndex}"><span class="answer-letter">${ANSWER_LABELS[optionIndex]}</span><span>${escapeHtml(option)}</span></button>`).join("")}</div><div class="quiz-footer"><button class="button button-outline" id="previousQuestion" ${index === 0 ? "disabled" : ""}>← Back</button><button class="button button-primary" id="nextQuestion">${index === questions.length - 1 ? isPractice ? "Finish practice" : "Submit answers" : "Next question →"}</button></div>`;
    document.getElementById("leaveQuiz").addEventListener("click", closeModal);
    document.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => {
      if (submitting || timeIsUp()) return;
      answers[index] = Number(button.dataset.answer);
      onChange?.([...answers]);
      paint();
    }));
    document.getElementById("previousQuestion").addEventListener("click", () => {
      if (submitting || timeIsUp()) return;
      if (index > 0) { index -= 1; paint(); }
    });
    document.getElementById("nextQuestion").addEventListener("click", async () => {
      if (submitting || timeIsUp()) return tick();
      if (answers[index] === null) return showToast("Choose an answer to continue.");
      if (index < questions.length - 1) { index += 1; paint(); return; }
      if (answers.some((answer) => answer === null)) {
        index = answers.findIndex((answer) => answer === null);
        paint();
        return showToast("Answer every question before submitting.");
      }
      submitting = true;
      const controls = [...modal.querySelectorAll("button")];
      controls.forEach((button) => { button.disabled = true; });
      try {
        await onFinish([...answers]);
      } catch (error) {
        showToast(userErrorMessage(error, "Could not submit your answers. Please try again."));
      } finally {
        submitting = false;
        if (controls[0]?.isConnected) paint();
      }
    });
    tick();
  };
  if (!openModal("")) return;
  paint();
  if (timed) {
    const timer = window.setInterval(tick, 1000);
    quizCleanup = () => window.clearInterval(timer);
  }
}


window.scholaShowToast = showToast;
window.scholaOpenModal = openModal;
window.scholaCloseModal = closeModal;
window.scholaSetModalLifecycle = (lifecycle) => { modalLifecycle = lifecycle; };
window.scholaOpenQuiz = openQuiz;
window.scholaUserErrorMessage = userErrorMessage;
window.scholaRefreshAccount = refreshAccount;

window.setInterval(() => {
  if (document.visibilityState === "visible" && accountSession && accountProfile && !recoveringPassword) window.ScholaLiveApp?.refresh();
}, 10000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && accountSession && accountProfile && !recoveringPassword) window.ScholaLiveApp?.refresh();
});

render();
if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") recoveringPassword = true;
    window.setTimeout(() => refreshAccount(session), 0);
  });
  refreshAccount();
}
