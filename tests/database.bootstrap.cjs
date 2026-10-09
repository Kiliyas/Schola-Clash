// CI/local PostgreSQL only. Hosted Supabase supplies Auth's real schema instead.
const { Client } = require("pg");
const fs = require("node:fs/promises");
const path = require("node:path");
async function main() {
  const value = process.env.SCHOLA_TEST_DATABASE_URL;
  if (!value) throw new Error("Set a private SCHOLA_TEST_DATABASE_URL for the local test server.");
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Bootstrap only supports a local disposable PostgreSQL server.");
  const client = new Client({ connectionString: value });
  try {
    await client.connect();
    const tables = await client.query("select count(*)::int as count from information_schema.tables where table_schema in ('public','auth','private') and table_type='BASE TABLE'");
    if (tables.rows[0].count) throw new Error("Refusing to bootstrap a database that already contains application tables.");
    await client.query(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;`);
    const directory = path.join(__dirname, "..", "supabase", "migrations");
    for (const file of (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
      await client.query(await fs.readFile(path.join(directory,file), "utf8"));
      console.log("PASS native migration " + file);
    }
  } finally { await client.end(); }
}
main().catch((error) => { console.error("Local database bootstrap failed: " + error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted connection]")); process.exitCode=1; });
