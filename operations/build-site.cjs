// Publish only the browser assets, never SQL, tests or administrator scripts.
const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const files = ["index.html", "styles.css", "app.js", "privacy.html",
  "supabase/client-config.js", "supabase/client.js", "supabase/live-app.js",
  "supabase/editor-drafts.js", "supabase/account-actions.js", "supabase/diagnostics.js"];
(async () => {
  const destination = path.join(root, "_site");
  // The resolved target is exactly the ignored build directory in this repo.
  if (destination !== path.resolve(root, "_site")) throw new Error("Invalid build directory");
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.join(destination, "supabase"), { recursive: true });
  for (const file of files) await fs.copyFile(path.join(root, file), path.join(destination, file));
  await fs.writeFile(path.join(destination, ".nojekyll"), "");
  console.log(`Prepared ${files.length} browser assets in _site.`);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
