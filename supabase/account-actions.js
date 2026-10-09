(() => {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]);
  async function mount({ client, session, profile, host }) {
    const userId = session.user.id;
    const section = document.createElement("section");
    section.className = "account-actions";
    section.innerHTML = `<h3>Account requests</h3><p class="small">Requests are reviewed by your school's administrator.</p><div id="accountRequestList" role="status">Loading requests...</div>${profile.role === "student" ? '<details><summary>Request teacher access</summary><form data-request-kind="teacher_access"><div class="field"><label for="teacherRequestNote">School and subject (optional)</label><input id="teacherRequestNote" name="note" maxlength="500" placeholder="School name and subject"></div><button type="submit" class="button button-secondary">Send request</button></form></details>' : ""}<details><summary>Request account deletion</summary><p class="small">An administrator will review deletion and any school record retention requirements. Sending this request does not delete data immediately.</p><form data-request-kind="deletion"><label><input type="checkbox" name="confirm" required> I want to request deletion of my account.</label><button type="submit" class="button button-outline">Request deletion</button></form></details><p class="small" id="accountRequestMessage" role="status" aria-live="polite"></p><a href="privacy.html" target="_blank" rel="noopener">Privacy and data retention</a>`;
    host.append(section);
    const message = section.querySelector("#accountRequestMessage");
    let pendingKinds = new Set();
    const submitting = new Set();
    let loadVersion = 0;
    function updateForms() {
      section.querySelectorAll("[data-request-kind]").forEach((form) => {
        const kind = form.dataset.requestKind;
        const button = form.querySelector("button");
        button.disabled = pendingKinds.has(kind) || submitting.has(kind);
        button.textContent = submitting.has(kind) ? "Sending..." : pendingKinds.has(kind) ? "Request pending"
          : kind === "teacher_access" ? "Send request" : "Request deletion";
      });
    }
    async function load() {
      const list = section.querySelector("#accountRequestList");
      const version = ++loadVersion;
      list.setAttribute("aria-busy", "true");
      let data, error;
      try {
        ({ data, error } = await client.from("account_requests").select("id, kind, status, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(20));
      } catch (failure) { error = failure; }
      if (!section.isConnected || version !== loadVersion) return;
      list.removeAttribute("aria-busy");
      if (error) {
        list.innerHTML = '<p class="small">Could not load requests.</p><button type="button" class="button button-outline" id="retryAccountRequests">Try again</button>';
        list.querySelector("button").addEventListener("click", () => {
          list.textContent = "Loading requests...";
          load();
        });
        return;
      }
      pendingKinds = new Set((data || []).filter((request) => request.status === "pending").map((request) => request.kind));
      updateForms();
      list.innerHTML = (data || []).map((request) => `<p>${request.kind === "teacher_access" ? "Teacher access" : "Account deletion"}: <strong>${escape(request.status)}</strong>${request.status === "pending" ? ` <button type="button" class="button button-quiet" data-cancel-request="${escape(request.id)}">Cancel request</button>` : ""}</p>`).join("") || '<p class="small">No account requests yet.</p>';
      list.querySelectorAll("[data-cancel-request]").forEach((button) => button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Cancelling...";
        try {
          const { error } = await client.rpc("cancel_account_request", { p_id: button.dataset.cancelRequest });
          if (error) throw error;
          if (!section.isConnected) return;
          message.textContent = "Request cancelled.";
          await load();
        } catch { message.textContent = "Could not cancel this request. Please try again."; }
        finally { button.disabled = false; button.textContent = "Cancel request"; }
      }));
    }
    section.querySelectorAll("[data-request-kind]").forEach((form) => form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const kind = form.dataset.requestKind;
      if (submitting.has(kind) || pendingKinds.has(kind)) return;
      submitting.add(kind); updateForms();
      form.setAttribute("aria-busy", "true");
      message.textContent = "Sending your request...";
      try {
        const { error } = await client.rpc("request_account_action", { p_kind: form.dataset.requestKind, p_note: form.elements.note?.value.trim() || "" });
        if (error) throw error;
        if (!section.isConnected) return;
        pendingKinds.add(kind);
        message.textContent = "Request received. You can check its status here.";
        await load();
      } catch (error) { message.textContent = window.scholaUserErrorMessage(error, "Could not send your request. Please try again."); }
      finally { submitting.delete(kind); form.removeAttribute("aria-busy"); updateForms(); }
    }));
    await load();
  }
  window.ScholaAccountActions = { mount };
})();
