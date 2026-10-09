(() => {
  const prefix = "schola-chapter-draft:";
  const lifetime = 7 * 24 * 60 * 60 * 1000;
  function clearUser(userId) {
    try {
      Object.keys(localStorage).filter((key) => key.startsWith(`${prefix}${userId}:`)).forEach((key) => localStorage.removeItem(key));
    } catch { /* A browser can deny storage access. */ }
  }
  function install({ userId, chapterId, version, getData, restoreData }) {
    const modal = document.getElementById("modal");
    const key = `${prefix}${userId}:${chapterId || "new"}`;
    let baseline = JSON.stringify(getData());
    let saved = false;
    let saving = false;
    let timer;
    let available = true;
    let ownsDraft = false;
    const status = document.createElement("p");
    status.className = "small chapter-draft-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = "Unsaved edits are backed up on this device for 7 days. Save the chapter to share them.";
    modal.querySelector(".modal-description").after(status);
    const dirty = () => saving || (!saved && JSON.stringify(getData()) !== baseline);
    const persist = () => {
      clearTimeout(timer);
      if (!dirty()) {
        if (ownsDraft && !saved) {
          try {
            localStorage.removeItem(key);
            ownsDraft = false;
            status.textContent = "No unsaved changes.";
          } catch {
            status.textContent = "Could not remove the local draft. Save the chapter before leaving.";
          }
        }
        return;
      }
      try {
        localStorage.setItem(key, JSON.stringify({ version: 1, baseVersion: version || null, savedAt: Date.now(), data: getData() }));
        ownsDraft = true;
        status.textContent = "Draft saved on this device. Save the chapter when you are ready.";
      } catch {
        available = false;
        status.textContent = "This browser cannot save a local draft. Keep this window open until you save the chapter.";
      }
    };
    try {
      for (const storedKey of Object.keys(localStorage).filter((item) => item.startsWith(prefix))) {
        try {
          const value = JSON.parse(localStorage.getItem(storedKey));
          if (!value?.savedAt || Date.now() - value.savedAt > lifetime) localStorage.removeItem(storedKey);
        } catch { localStorage.removeItem(storedKey); }
      }
      const stored = JSON.parse(localStorage.getItem(key));
      if (stored?.version === 1 && stored.data && Array.isArray(stored.data.questions) && stored.data.questions.length <= 100) {
        const banner = document.createElement("div");
        banner.className = "chapter-draft-banner";
        const message = document.createElement("p");
        message.textContent = stored.baseVersion !== (version || null)
          ? "A draft exists on this device, but the chapter has changed since then. Restore only if you want to use the older draft."
          : "You have an unsaved draft on this device.";
        const restore = document.createElement("button");
        restore.type = "button"; restore.className = "button button-secondary"; restore.textContent = "Restore draft"; restore.id = "restoreChapterDraft";
        const discard = document.createElement("button");
        discard.type = "button"; discard.className = "button button-quiet"; discard.textContent = "Discard draft"; discard.id = "discardChapterDraft";
        restore.addEventListener("click", () => {
          try { restoreData(stored.data); ownsDraft = true; banner.remove(); persist(); }
          catch { message.textContent = "This draft could not be restored. You can discard it and use the saved chapter."; }
        });
        discard.addEventListener("click", () => {
          try { localStorage.removeItem(key); banner.remove(); }
          catch { message.textContent = "Could not discard the draft. Your browser may be blocking storage access."; }
        });
        banner.append(message, restore, discard); status.after(banner);
      }
    } catch { available = false; status.textContent = "Local draft storage is unavailable. Save the chapter before leaving."; }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(persist, 400); };
    modal.addEventListener("input", schedule);
    modal.addEventListener("change", schedule);
    modal.addEventListener("click", schedule);
    window.scholaSetModalLifecycle({ dirty, busy: () => saving, flush: persist,
      closeMessage: () => available ? "Close the chapter editor? Your unsaved draft is kept on this device. You can restore it when you reopen the chapter."
        : "This browser cannot save a local draft. Closing now will lose your unsaved changes. Close anyway?",
      cleanup() {
      if (available) persist();
      clearTimeout(timer);
      modal.removeEventListener("input", schedule);
      modal.removeEventListener("change", schedule);
      modal.removeEventListener("click", schedule);
    } });
    return { setSaving(value) { saving = value; }, saved() {
      saved = true; saving = false;
      clearTimeout(timer);
      try { localStorage.removeItem(key); } catch { /* No draft to remove. */ }
    } };
  }
  window.ScholaEditorDrafts = { install, clearUser };
})();
