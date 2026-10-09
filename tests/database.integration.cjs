// Run only against a disposable Supabase test project, never the live project.
const { Client } = require("pg");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
async function main() {
  const connectionString = process.env.SCHOLA_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("Set SCHOLA_TEST_DATABASE_URL to a disposable test database's administrator connection.");
  if (connectionString.includes("bqhzqsyfzbwprhummugp")) throw new Error("Refusing synthetic concurrent tests on the live project. Use a disposable test project.");
  const clients = Array.from({ length: 3 }, () => new Client({ connectionString, statement_timeout: 20000, connectionTimeoutMillis: 15000 }));
  let ids;
  const acting = async (client, userId, sql, params = []) => {
    await client.query("begin");
    try {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
      await client.query("select pg_sleep(0.25)");
      const result = await client.query(sql, params);
      await client.query("commit");
      return result.rows;
    } catch (error) { await client.query("rollback"); throw error; }
  };
  try {
    await Promise.all(clients.map((client) => client.connect()));
    const [admin, first, second] = clients;
    await admin.query(await fs.readFile(path.join(__dirname, "reliability.sql"), "utf8"));
    await admin.query(await fs.readFile(path.join(__dirname, "timed-matches.sql"), "utf8"));
    const results = await admin.query(await fs.readFile(path.join(__dirname, "live-concurrency-setup.sql"), "utf8"));
    ids = results[results.length - 1].rows[0];
    await Promise.all([first, second].map((client) => acting(client, ids.two, "select public.accept_challenge($1)", [ids.challenge])));
    const matches = await admin.query("select id from public.matches where challenge_id=$1", [ids.challenge]);
    assert.equal(matches.rowCount, 1, "Concurrent acceptance must create exactly one match");
    const matchId = matches.rows[0].id;
    const answers = async (userId, wrong) => (await admin.query(`select jsonb_agg(case when $3 then (choice.ordinality % 4)::int else (choice.ordinality - 1)::int end order by q.position) as answers
      from public.match_player_questions pq join public.match_questions q on q.id=pq.match_question_id
      cross join lateral jsonb_array_elements(pq.display_order) with ordinality as choice(value,ordinality)
      where pq.match_id=$1 and pq.user_id=$2 and choice.value='0'::jsonb`, [matchId, userId, wrong])).rows[0].answers;
    const correct = await answers(ids.one, false), incorrect = await answers(ids.two, true);
    await Promise.all([acting(first, ids.one, "select public.submit_match_answers($1,$2)", [matchId, JSON.stringify(correct)]), acting(second, ids.two, "select public.submit_match_answers($1,$2)", [matchId, JSON.stringify(incorrect)])]);
    await Promise.all([first, second].map((client) => acting(client, ids.one, "select public.submit_match_answers($1,$2)", [matchId, JSON.stringify(correct)])));
    const state = await admin.query("select status, rating_applied from public.matches where id=$1", [matchId]);
    assert.equal(state.rows[0].status, "completed"); assert.equal(state.rows[0].rating_applied, true);
    const ratings = await admin.query("select user_id,rating from public.stream_ratings where stream_id=$1 order by user_id", [ids.stream]);
    assert.equal(ratings.rows.find((row) => row.user_id === ids.one).rating, 1016);
    assert.equal(ratings.rows.find((row) => row.user_id === ids.two).rating, 984);
    console.log("PASS real PostgreSQL concurrent acceptance, submission, duplicate retry, scores and ELO");
    const dummy = (await admin.query("insert into public.challenges(chapter_id,challenger_id,opponent_id,status) values($1,$2,$3,'accepted') returning id", [ids.chapter, ids.one, ids.two])).rows[0].id;
    await admin.query("insert into public.matches(challenge_id,chapter_id,stream_id,player_one_id,player_two_id,status) values($1,$2,$3,$4,$5,'no_contest')", [dummy,ids.chapter,ids.stream,ids.one,ids.two]);
    const invitations = (await admin.query("insert into public.challenges(chapter_id,challenger_id,opponent_id) values($1,$2,$3),($1,$2,$4) returning id,opponent_id", [ids.chapter, ids.one, ids.three, ids.four])).rows;
    const raced = await Promise.all([acting(first, ids.three, "select public.accept_challenge($1) as result", [invitations.find((row) => row.opponent_id === ids.three).id]), acting(second, ids.four, "select public.accept_challenge($1) as result", [invitations.find((row) => row.opponent_id === ids.four).id])]);
    assert.deepEqual(raced.map((result) => result[0].result.status).sort(), ["active", "match_limit_reached"]);
    const count = await admin.query("select count(*)::int as count from public.matches where chapter_id=$1 and $2 in (player_one_id,player_two_id)", [ids.chapter, ids.one]);
    assert.equal(count.rows[0].count, 3, "Concurrent acceptance must never spend a fourth match");
    console.log("PASS concurrent three-match boundary across different opponents");
  } finally {
    if (ids) {
      const admin = clients[0];
      await admin.query("begin");
      try {
        // Only rows linked to this freshly generated run may be deleted.
        const users = (await admin.query("select id from auth.users where raw_user_meta_data->>'schola_test_run'=$1", [ids.run_id])).rows.map((row) => row.id);
        assert.equal(users.length, 5);
        await admin.query("delete from public.matches where stream_id=$1 and player_one_id=any($2::uuid[]) and player_two_id=any($2::uuid[])", [ids.stream, users]);
        await admin.query("delete from public.challenges where chapter_id=$1 and challenger_id=any($2::uuid[]) and opponent_id=any($2::uuid[])", [ids.chapter, users]);
        await admin.query("update public.chapters set published_at=null where stream_id=$1", [ids.stream]);
        await admin.query("delete from public.teacher_streams where id=$1 and owner_user_id=any($2::uuid[])", [ids.stream, users]);
        await admin.query("delete from auth.users where id=any($1::uuid[]) and raw_user_meta_data->>'schola_test_run'=$2", [users, ids.run_id]);
        await admin.query("commit");
        console.log("PASS synthetic data cleanup");
      } catch (error) { await admin.query("rollback"); throw error; }
    }
    await Promise.allSettled(clients.map((client) => client.end()));
  }
}
main().catch((error) => { console.error("Database integration check failed: " + error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted connection]")); process.exitCode = 1; });
