// An isolated PostgreSQL engine validates migrations and transactional invariants.
// This does not substitute for concurrent sessions against a hosted PostgreSQL server.
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");
async function main() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;`);
    const migrationDir = path.join(__dirname, "..", "supabase", "migrations");
    for (const file of (await fs.readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort()) {
      await db.exec(await fs.readFile(path.join(migrationDir, file), "utf8"));
      console.log(`PASS migration ${file}`);
    }
    for (const file of ["timed-matches.sql", "reliability.sql"]) {
      await db.exec(await fs.readFile(path.join(__dirname, file), "utf8"));
      console.log(`PASS database ${file}`);
    }
    const users = await db.query("select count(*)::int as count from auth.users");
    assert.equal(users.rows[0].count, 0, "Synthetic users must be rolled back");
    const sample = await db.query("insert into auth.users(id,raw_user_meta_data,raw_app_meta_data) values(gen_random_uuid(), '{\"display_name\":\"Restore check student\"}', '{}') returning id");
    const dump = await db.dumpDataDir();
    const restored = new PGlite({ loadDataDir: dump });
    try {
      const schema = await restored.query("select count(*)::int as count from information_schema.tables where table_schema='public' and table_name in ('chapters','classrooms','practice_attempts','account_requests')");
      assert.equal(schema.rows[0].count, 4);
      const profile = await restored.query("select display_name from public.user_profiles where id=$1", [sample.rows[0].id]);
      assert.equal(profile.rows[0].display_name, "Restore check student", "Restored data must match the source snapshot");
      await restored.exec(await fs.readFile(path.join(__dirname, "reliability.sql"), "utf8"));
      console.log("PASS isolated snapshot restore and revalidation");
    } finally { await restored.close(); }
  } finally { await db.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
