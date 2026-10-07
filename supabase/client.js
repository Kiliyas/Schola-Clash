(() => {
  const config = window.SCHOLA_SUPABASE_CONFIG;
  if (!config || !window.supabase?.createClient) {
    window.scholaSupabase = null;
    return;
  }

  window.scholaSupabase = window.supabase.createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true
    }
  });
})();
