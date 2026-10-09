(() => {
  const recent = new Map();
  let activeUser = null;
  window.scholaSetDiagnosticUser = (id) => { activeUser = id; recent.clear(); };
  window.scholaReportError = (context, error) => {
    if (!activeUser || !window.scholaSupabase) return;
    const allowed = new Set(["workspace", "account", "chapter", "practice", "match", "unhandled"]);
    if (!allowed.has(context)) return;
    const raw = typeof error?.code === "string" ? error.code : "client_error";
    const code = /^[A-Za-z0-9_]{1,40}$/.test(raw) ? raw : "client_error";
    const key = `${context}:${code}`;
    if (Date.now() - (recent.get(key) || 0) < 60000) return;
    recent.set(key, Date.now());
    // No message, stack trace, source text, URL, or credentials leave the browser.
    Promise.resolve(window.scholaSupabase.rpc("report_client_error", { p_context: context, p_code: code })).catch(() => {});
  };
  window.addEventListener("error", () => window.scholaReportError("unhandled", { code: "javascript_error" }));
  window.addEventListener("unhandledrejection", () => window.scholaReportError("unhandled", { code: "promise_rejection" }));
})();
