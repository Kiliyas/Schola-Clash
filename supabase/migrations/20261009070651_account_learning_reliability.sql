-- Reversible lifecycle operations keep existing match snapshots and history.
alter table public.classrooms add column archived_at timestamptz;
alter table public.chapters add column archived_at timestamptz;

create or replace function private.can_access_class(p_class_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_manage_class(p_class_id) or exists (
    select 1 from public.class_members cm join public.classrooms c on c.id = cm.class_id
    where cm.class_id = p_class_id and cm.user_id = (select auth.uid()) and c.archived_at is null
  );
$$;
create or replace function private.can_access_stream(p_stream_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_manage_stream(p_stream_id) or exists (
    select 1 from public.classrooms c join public.class_members cm on cm.class_id = c.id
    where c.stream_id = p_stream_id and cm.user_id = (select auth.uid()) and c.archived_at is null
  );
$$;
create or replace function private.can_read_chapter(p_chapter_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chapters ch where ch.id = p_chapter_id and (
      private.can_manage_stream(ch.stream_id) or (
        ch.published_at is not null and ch.archived_at is null and exists (
          select 1 from public.chapter_classes cc
          join public.class_members cm on cm.class_id = cc.class_id
          join public.classrooms c on c.id = cc.class_id
          where cc.chapter_id = ch.id and cm.user_id = (select auth.uid()) and c.archived_at is null
        )
      )
    )
  );
$$;
create or replace function private.student_has_chapter(p_user_id uuid, p_chapter_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_student_profile(p_user_id) and exists (
    select 1 from public.chapters ch join public.chapter_classes cc on cc.chapter_id = ch.id
    join public.classrooms c on c.id = cc.class_id join public.class_members cm on cm.class_id = c.id
    where ch.id = p_chapter_id and ch.published_at is not null and ch.archived_at is null
      and c.archived_at is null and cm.user_id = p_user_id
  );
$$;
revoke all on function private.student_has_chapter(uuid, uuid) from public, anon, authenticated;

create function private.manage_chapter(p_chapter_id uuid, p_action text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_chapter public.chapters%rowtype;
  v_copy uuid;
  v_questions jsonb;
  v_classes uuid[];
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  select * into v_chapter from public.chapters where id = p_chapter_id;
  if not found or not private.can_manage_stream(v_chapter.stream_id) then raise exception 'Only the chapter owner can manage it.'; end if;
  if p_action not in ('archive', 'restore', 'unpublish', 'copy') then raise exception 'Unknown chapter action.'; end if;
  -- Lock invitations before the chapter, matching acceptance's lock order.
  if p_action in ('archive', 'unpublish') then
    update public.challenges set status = 'cancelled' where chapter_id = p_chapter_id and status = 'pending';
  end if;
  select * into v_chapter from public.chapters where id = p_chapter_id for update;
  if p_action = 'archive' then
    update public.chapters set archived_at = clock_timestamp() where id = p_chapter_id;
  elsif p_action = 'restore' then
    update public.chapters set archived_at = null where id = p_chapter_id;
  elsif p_action = 'unpublish' then
    update public.chapters set published_at = null where id = p_chapter_id;
  else
    select array_agg(cc.class_id) into v_classes from public.chapter_classes cc
      join public.classrooms c on c.id = cc.class_id where cc.chapter_id = p_chapter_id and c.archived_at is null;
    if v_classes is null then raise exception 'Add an active class before copying this chapter.'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('prompt', q.prompt, 'options', q.options,
      'correct_option_index', k.correct_option_index, 'explanation', k.explanation) order by q.position), '[]'::jsonb)
    into v_questions from public.chapter_questions q join public.question_answer_keys k on k.question_id = q.id where q.chapter_id = p_chapter_id;
    v_copy := private.save_chapter(v_chapter.stream_id, null, left(v_chapter.title, 153) || ' (copy)', v_chapter.subject, v_classes, v_questions, false);
    return v_copy;
  end if;
  return p_chapter_id;
end;
$$;
create function public.manage_chapter(p_chapter_id uuid, p_action text)
returns uuid language sql security invoker set search_path = '' as $$ select private.manage_chapter(p_chapter_id, p_action); $$;

create function private.manage_class(p_class_id uuid, p_action text, p_name text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.can_manage_class(p_class_id) then raise exception 'Only the class owner can manage it.'; end if;
  if p_action = 'rename' then
    if p_name is null or length(btrim(p_name)) not between 1 and 100 then raise exception 'Enter a class name of 1 to 100 characters.'; end if;
    update public.classrooms set name = btrim(p_name) where id = p_class_id;
  elsif p_action = 'archive' then
    update public.challenges set status = 'cancelled' where status = 'pending' and chapter_id in (select chapter_id from public.chapter_classes where class_id = p_class_id);
    update public.classrooms set archived_at = clock_timestamp() where id = p_class_id;
    delete from public.class_invites where class_id = p_class_id;
  elsif p_action = 'restore' then
    update public.classrooms set archived_at = null where id = p_class_id;
  else raise exception 'Unknown class action.';
  end if;
  return p_class_id;
end;
$$;
create function public.manage_class(p_class_id uuid, p_action text, p_name text default null)
returns uuid language sql security invoker set search_path = '' as $$ select private.manage_class(p_class_id, p_action, p_name); $$;

create table public.practice_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  correct_count integer not null check (correct_count >= 0),
  question_count integer not null check (question_count between 1 and 100 and correct_count <= question_count),
  missed_question_ids uuid[] not null,
  created_at timestamptz not null default now()
);
create index practice_attempts_user_chapter_idx on public.practice_attempts(user_id, chapter_id, created_at desc);
alter table public.practice_attempts enable row level security;
create policy practice_attempts_read on public.practice_attempts for select to authenticated
using (user_id = (select auth.uid()) or exists (select 1 from public.chapters ch where ch.id = chapter_id and private.can_manage_stream(ch.stream_id)));
revoke all on public.practice_attempts from anon, authenticated;
grant select on public.practice_attempts to authenticated;

create function private.submit_practice(p_chapter_id uuid, p_answers jsonb, p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_total integer;
  v_correct integer;
  v_missed uuid[];
  v_existing public.practice_attempts%rowtype;
begin
  if p_attempt_id is null then raise exception 'A practice attempt ID is required.'; end if;
  if v_user is null then raise exception 'Sign in before saving practice.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('practice:' || p_attempt_id::text, 0));
  select * into v_existing from public.practice_attempts where id = p_attempt_id;
  if found then
    if v_existing.user_id <> v_user or v_existing.chapter_id <> p_chapter_id then raise exception 'Invalid practice attempt.'; end if;
    return jsonb_build_object('correct_count', v_existing.correct_count, 'question_count', v_existing.question_count);
  end if;
  if v_user is null or not private.student_has_chapter(v_user, p_chapter_id) then raise exception 'This chapter is not available to your student account.'; end if;
  if jsonb_typeof(p_answers) is distinct from 'array' or jsonb_array_length(p_answers) not between 1 and 100 then raise exception 'Submit between 1 and 100 answers.'; end if;
  v_total := jsonb_array_length(p_answers);
  if exists (select 1 from jsonb_array_elements(p_answers) a where a->>'answer' is null or a->>'answer' !~ '^[0-3]$' or a->>'question_id' is null)
    or (select count(distinct a->>'question_id') from jsonb_array_elements(p_answers) a) <> v_total then raise exception 'Each question needs one valid answer.'; end if;
  if (select count(*) from jsonb_array_elements(p_answers) a join public.chapter_questions q on q.id = (a->>'question_id')::uuid and q.chapter_id = p_chapter_id) <> v_total then
    raise exception 'The chapter has changed. Restart practice to use the latest questions.';
  end if;
  select count(*) filter (where (a->>'answer')::integer = k.correct_option_index),
    coalesce(array_agg(q.id) filter (where (a->>'answer')::integer <> k.correct_option_index), '{}'::uuid[])
  into v_correct, v_missed from jsonb_array_elements(p_answers) a
    join public.chapter_questions q on q.id = (a->>'question_id')::uuid
    join public.question_answer_keys k on k.question_id = q.id;
  insert into public.practice_attempts(id, user_id, chapter_id, correct_count, question_count, missed_question_ids)
  values (p_attempt_id, v_user, p_chapter_id, v_correct, v_total, v_missed);
  return jsonb_build_object('correct_count', v_correct, 'question_count', v_total);
end;
$$;
create function public.submit_practice(p_chapter_id uuid, p_answers jsonb, p_attempt_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.submit_practice(p_chapter_id, p_answers, p_attempt_id); $$;

create function private.learning_progress(p_stream_id uuid default null)
returns table(chapter_id uuid, user_id uuid, attempt_count bigint, correct_count bigint, question_count bigint, latest_accuracy integer, last_practiced_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  if p_stream_id is not null and not private.can_manage_stream(p_stream_id) then raise exception 'Only the teacher can view class practice progress.'; end if;
  return query select a.chapter_id, a.user_id, count(*), sum(a.correct_count)::bigint, sum(a.question_count)::bigint,
    (array_agg(round(100.0*a.correct_count/a.question_count)::integer order by a.created_at desc, a.id desc))[1], max(a.created_at)
  from public.practice_attempts a join public.chapters ch on ch.id = a.chapter_id
  where (p_stream_id is null and a.user_id = (select auth.uid())) or (p_stream_id is not null and ch.stream_id = p_stream_id)
  group by a.chapter_id, a.user_id;
end;
$$;
create function public.get_learning_progress(p_stream_id uuid default null)
returns table(chapter_id uuid, user_id uuid, attempt_count bigint, correct_count bigint, question_count bigint, latest_accuracy integer, last_practiced_at timestamptz)
language sql security invoker set search_path = '' as $$ select * from private.learning_progress(p_stream_id); $$;

create function private.missed_practice_questions(p_chapter_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_questions jsonb;
begin
  if not private.student_has_chapter((select auth.uid()), p_chapter_id) then raise exception 'This chapter is not available to your student account.'; end if;
  select missed_question_ids into v_ids from public.practice_attempts where user_id = (select auth.uid()) and chapter_id = p_chapter_id order by created_at desc, id desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'prompt', q.prompt, 'options', q.options,
    'correct_option_index', k.correct_option_index, 'explanation', k.explanation) order by q.position), '[]'::jsonb)
  into v_questions from public.chapter_questions q join public.question_answer_keys k on k.question_id = q.id
  where q.chapter_id = p_chapter_id and q.id = any(coalesce(v_ids, '{}'::uuid[]));
  return v_questions;
end;
$$;
create function public.get_missed_practice_questions(p_chapter_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.missed_practice_questions(p_chapter_id); $$;
revoke all on function private.missed_practice_questions(uuid), public.get_missed_practice_questions(uuid) from public, anon;
grant execute on function private.missed_practice_questions(uuid), public.get_missed_practice_questions(uuid) to authenticated;

create table public.account_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  kind text not null check (kind in ('teacher_access', 'deletion')),
  note text not null default '' check(length(note) <= 500),
  status text not null default 'pending' check(status in ('pending', 'approved', 'rejected', 'cancelled', 'completed')),
  created_at timestamptz not null default now(), resolved_at timestamptz
);
create unique index account_requests_pending_idx on public.account_requests(user_id, kind) where status = 'pending';
alter table public.account_requests enable row level security;
create policy account_requests_read_self on public.account_requests for select to authenticated using(user_id = (select auth.uid()));
revoke all on public.account_requests from anon, authenticated;
grant select on public.account_requests to authenticated;
create function private.request_account_action(p_kind text, p_note text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  if p_kind not in ('teacher_access', 'deletion') or length(coalesce(p_note,'')) > 500 then raise exception 'Invalid account request.'; end if;
  if p_kind = 'teacher_access' and private.is_teacher_profile((select auth.uid())) then raise exception 'Your account already has teacher access.'; end if;
  insert into public.account_requests(user_id, kind, note) values ((select auth.uid()), p_kind, btrim(coalesce(p_note,'')))
  on conflict (user_id, kind) where status = 'pending' do update set note = excluded.note returning id into v_id;
  return v_id;
end;
$$;
create function public.request_account_action(p_kind text, p_note text default '')
returns uuid language sql security invoker set search_path = '' as $$ select private.request_account_action(p_kind, p_note); $$;
create function private.cancel_account_request(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.account_requests set status = 'cancelled', resolved_at = clock_timestamp()
  where id = p_id and user_id = (select auth.uid()) and status = 'pending';
$$;
create function public.cancel_account_request(p_id uuid)
returns void language sql security invoker set search_path = '' as $$ select private.cancel_account_request(p_id); $$;

-- Diagnostics intentionally contain no error text, stack, email, answers, or URL tokens.
create table private.client_errors (
  id uuid primary key default gen_random_uuid(), user_id uuid references public.user_profiles(id) on delete set null,
  context text not null, code text not null, created_at timestamptz not null default now()
);
alter table private.client_errors enable row level security;
revoke all on private.client_errors from public, anon, authenticated;
create index client_errors_created_idx on private.client_errors(created_at);
create function private.report_client_error(p_context text, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then return; end if;
  if p_context not in ('workspace', 'account', 'chapter', 'practice', 'match', 'unhandled') then return; end if;
  if p_code is null or p_code !~ '^[A-Za-z0-9_]{1,40}$' then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('diagnostic:' || v_user::text, 0));
  if (select count(*) from private.client_errors where user_id = v_user and created_at > now() - interval '1 hour') >= 10 then return; end if;
  insert into private.client_errors(user_id, context, code) values(v_user, p_context, p_code);
end;
$$;
create function public.report_client_error(p_context text, p_code text)
returns void language sql security invoker set search_path = '' as $$ select private.report_client_error(p_context, p_code); $$;

-- Only database administrators may run retention maintenance.
create function private.purge_operational_data()
returns void language sql security invoker set search_path = '' as $$
  delete from private.client_errors where created_at < now() - interval '30 days';
  delete from public.practice_attempts where created_at < now() - interval '365 days';
  delete from public.account_requests where status in ('cancelled', 'rejected', 'completed') and resolved_at < now() - interval '90 days';
$$;
revoke all on function private.purge_operational_data() from public, anon, authenticated;

revoke all on function private.manage_chapter(uuid,text), public.manage_chapter(uuid,text),
  private.manage_class(uuid,text,text), public.manage_class(uuid,text,text),
  private.submit_practice(uuid,jsonb,uuid), public.submit_practice(uuid,jsonb,uuid),
  private.learning_progress(uuid), public.get_learning_progress(uuid),
  private.request_account_action(text,text), public.request_account_action(text,text),
  private.cancel_account_request(uuid), public.cancel_account_request(uuid), private.report_client_error(text,text), public.report_client_error(text,text) from public, anon;
grant execute on function private.manage_chapter(uuid,text), public.manage_chapter(uuid,text),
  private.manage_class(uuid,text,text), public.manage_class(uuid,text,text),
  private.submit_practice(uuid,jsonb,uuid), public.submit_practice(uuid,jsonb,uuid),
  private.learning_progress(uuid), public.get_learning_progress(uuid),
  private.request_account_action(text,text), public.request_account_action(text,text),
  private.cancel_account_request(uuid), public.cancel_account_request(uuid), private.report_client_error(text,text), public.report_client_error(text,text) to authenticated;

create or replace function private.create_challenge(p_chapter_id uuid, p_opponent_id uuid)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_lock_user uuid;
  v_challenge_id uuid;
begin
  if v_user_id is null then raise exception 'Sign in before challenging a classmate.'; end if;
  if p_opponent_id = v_user_id then raise exception 'You cannot challenge yourself.'; end if;
  if not private.student_has_chapter(v_user_id, p_chapter_id) or not private.student_has_chapter(p_opponent_id, p_chapter_id) then
    raise exception 'Both players must be students assigned to this published chapter.';
  end if;

  for v_lock_user in
    select u.user_id from unnest(array[v_user_id, p_opponent_id]) as u(user_id) order by u.user_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_user::text || ':' || p_chapter_id::text, 0));
  end loop;

  if exists (
    select 1 from public.challenges c
    where c.chapter_id = p_chapter_id and c.status = 'pending'
      and c.expires_at > clock_timestamp()
      and (c.challenger_id in (v_user_id, p_opponent_id) or c.opponent_id in (v_user_id, p_opponent_id))
  ) then
    raise exception 'One of these students already has an open invitation for this chapter.';
  end if;

  if exists (
    select 1 from unnest(array[v_user_id, p_opponent_id]) player(user_id)
    where (select count(*) from public.matches m where m.chapter_id = p_chapter_id
      and player.user_id in (m.player_one_id, m.player_two_id)) >= 3
  ) then
    raise exception 'One of these students has used all three ranked matches for this chapter.';
  end if;

  insert into public.challenges (chapter_id, challenger_id, opponent_id)
  values (p_chapter_id, v_user_id, p_opponent_id)
  returning id into v_challenge_id;
  return v_challenge_id;
end;
$$;
create or replace function private.accept_challenge(p_challenge_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_challenge public.challenges%rowtype;
  v_chapter public.chapters%rowtype;
  v_lock_user uuid;
  v_match_id uuid;
  v_question_count integer;
  v_match_size integer;
  v_position integer := 0;
  v_question record;
  v_match_question_id uuid;
  v_player_id uuid;
  v_order integer[];
  v_first_order integer[];
  v_now timestamptz;
  v_deadline timestamptz;
  v_has_room boolean;
begin
  if v_user_id is null then raise exception 'Sign in before accepting an invitation.'; end if;
  select * into v_challenge from public.challenges c where c.id = p_challenge_id for update;
  if not found or v_challenge.opponent_id <> v_user_id then
    raise exception 'This invitation does not belong to the signed-in student.';
  end if;
  if v_challenge.status <> 'pending' then
    return jsonb_build_object('status', v_challenge.status::text);
  end if;
  v_now := clock_timestamp();
  if v_challenge.expires_at <= v_now then
    update public.challenges set status = 'expired' where id = p_challenge_id;
    return jsonb_build_object('status', 'expired');
  end if;
  for v_lock_user in
    select u.user_id from unnest(array[v_challenge.challenger_id, v_challenge.opponent_id]) as u(user_id)
    order by u.user_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_user::text || ':' || v_challenge.chapter_id::text, 0));
  end loop;
  select * into v_chapter from public.chapters ch
  where ch.id = v_challenge.chapter_id and ch.published_at is not null and ch.archived_at is null for share;
  if not found then raise exception 'This chapter is no longer published.'; end if;
  if not private.student_has_chapter(v_challenge.challenger_id, v_challenge.chapter_id)
    or not private.student_has_chapter(v_challenge.opponent_id, v_challenge.chapter_id) then
    raise exception 'Both students must still belong to an active class assigned to this chapter.';
  end if;
  select not exists (
    select 1 from unnest(array[v_challenge.challenger_id, v_challenge.opponent_id]) player(user_id)
    where (select count(*) from public.matches m where m.chapter_id = v_challenge.chapter_id
      and player.user_id in (m.player_one_id, m.player_two_id)) >= 3
  ) into v_has_room;
  if not v_has_room then return jsonb_build_object('status', 'match_limit_reached'); end if;
  select count(*) into v_question_count from public.chapter_questions q where q.chapter_id = v_challenge.chapter_id;
  v_match_size := least(v_question_count, greatest(5, floor(v_question_count::numeric / 3)::integer));
  v_now := clock_timestamp();
  if v_challenge.expires_at <= v_now then
    update public.challenges set status = 'expired' where id = p_challenge_id;
    return jsonb_build_object('status', 'expired');
  end if;
  v_deadline := v_now + private.ranked_match_duration(v_match_size);
  insert into public.matches (
    challenge_id, chapter_id, stream_id, player_one_id, player_two_id, started_at, deadline_at
  ) values (
    v_challenge.id, v_challenge.chapter_id, v_chapter.stream_id,
    v_challenge.challenger_id, v_challenge.opponent_id, v_now, v_deadline
  ) returning id into v_match_id;
  insert into public.stream_ratings (stream_id, user_id)
  values (v_chapter.stream_id, v_challenge.challenger_id), (v_chapter.stream_id, v_challenge.opponent_id)
  on conflict (stream_id, user_id) do nothing;
  insert into public.match_attempts (match_id, user_id)
  values (v_match_id, v_challenge.challenger_id), (v_match_id, v_challenge.opponent_id);
  for v_question in
    select q.id, q.prompt, q.options, k.correct_option_index, k.explanation
    from public.chapter_questions q join public.question_answer_keys k on k.question_id = q.id
    where q.chapter_id = v_challenge.chapter_id order by random() limit v_match_size
  loop
    v_position := v_position + 1;
    insert into public.match_questions (match_id, source_question_id, position, prompt, options)
    values (v_match_id, v_question.id, v_position, v_question.prompt, v_question.options)
    returning id into v_match_question_id;
    insert into public.match_question_keys (match_question_id, correct_option_index, explanation)
    values (v_match_question_id, v_question.correct_option_index, v_question.explanation);
    v_first_order := null;
    for v_player_id in
      select p.user_id from unnest(array[v_challenge.challenger_id, v_challenge.opponent_id]) as p(user_id)
    loop
      loop
        select array_agg(candidate.option_index order by random()) into v_order
        from generate_series(0, 3) as candidate(option_index);
        exit when v_player_id = v_challenge.challenger_id
          or array_position(v_order, v_question.correct_option_index::integer)
             <> array_position(v_first_order, v_question.correct_option_index::integer);
      end loop;
      if v_player_id = v_challenge.challenger_id then v_first_order := v_order; end if;
      insert into public.match_player_questions (match_id, user_id, match_question_id, display_order)
      values (v_match_id, v_player_id, v_match_question_id, to_jsonb(v_order));
    end loop;
  end loop;
  update public.challenges set status = 'accepted', accepted_at = v_now where id = v_challenge.id;
  return jsonb_build_object('status', 'active', 'match_id', v_match_id, 'deadline_at', v_deadline, 'server_now', clock_timestamp());
end;
$$;
create or replace function private.join_class_by_code(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[-[:space:]]', '', 'g'));
  v_class_id uuid;
  v_class_name text;
  v_stream_name text;
  v_inserted integer;
begin
  if v_user_id is null then raise exception 'Sign in before joining a class.'; end if;
  if not private.is_student_profile(v_user_id) then
    raise exception 'Only student accounts can join a class with an invitation code.';
  end if;
  if v_code !~ '^[A-F0-9]{12}$' then raise exception 'Enter a valid 12-character class code.'; end if;

  select c.id, c.name, s.name
    into v_class_id, v_class_name, v_stream_name
  from public.class_invites i
  join public.classrooms c on c.id = i.class_id
  join public.teacher_streams s on s.id = c.stream_id
  where i.code = v_code and i.expires_at > clock_timestamp() and c.archived_at is null;
  if not found then raise exception 'This class code is invalid or expired.'; end if;

  insert into public.class_members (class_id, user_id)
  values (v_class_id, v_user_id)
  on conflict (class_id, user_id) do nothing;
  get diagnostics v_inserted = row_count;

  return jsonb_build_object(
    'status', case when v_inserted = 1 then 'joined' else 'already_member' end,
    'class_id', v_class_id,
    'class_name', v_class_name,
    'stream_name', v_stream_name
  );
end;
$$;
create or replace function private.save_chapter(
  p_stream_id uuid,
  p_chapter_id uuid,
  p_title text,
  p_subject text,
  p_class_ids uuid[],
  p_questions jsonb,
  p_publish boolean
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_chapter_id uuid := p_chapter_id;
  v_existing public.chapters%rowtype;
  v_class_count integer;
  v_question record;
  v_question_id uuid;
  v_prompt text;
  v_correct text;
  v_position integer;
begin
  if v_user_id is null then raise exception 'Sign in before saving a chapter.'; end if;
  if not private.can_manage_stream(p_stream_id) then
    raise exception 'Only the owner can save chapters to this stream.';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 160 then
    raise exception 'Enter a chapter title of 1 to 160 characters.';
  end if;
  if length(coalesce(p_subject, '')) > 100 then raise exception 'Subject must be 100 characters or fewer.'; end if;
  if p_class_ids is null or cardinality(p_class_ids) = 0 then
    raise exception 'Assign the chapter to at least one class.';
  end if;
  if cardinality(p_class_ids) > 50 then raise exception 'Choose no more than 50 classes.'; end if;
  select count(distinct c.id) into v_class_count
  from unnest(p_class_ids) as requested(class_id)
  join public.classrooms c on c.id = requested.class_id and c.stream_id = p_stream_id and c.archived_at is null;
  if v_class_count <> cardinality(p_class_ids) then
    raise exception 'Every selected class must belong to this teacher stream; remove duplicate classes and try again.';
  end if;
  if jsonb_typeof(p_questions) is distinct from 'array' then
    raise exception 'Questions must be supplied as a list.';
  end if;
  if jsonb_array_length(p_questions) > 100 then raise exception 'A chapter can contain no more than 100 questions.'; end if;
  if coalesce(p_publish, false) and jsonb_array_length(p_questions) < 15 then
    raise exception 'Add at least 15 complete questions before publishing.';
  end if;

  for v_question in
    select item.value, item.ordinality
    from jsonb_array_elements(p_questions) with ordinality as item(value, ordinality)
  loop
    v_prompt := v_question.value ->> 'prompt';
    v_correct := v_question.value ->> 'correct_option_index';
    if v_prompt is null or length(btrim(v_prompt)) not between 1 and 2000 then
      raise exception 'Question % needs text of 1 to 2,000 characters.', v_question.ordinality;
    end if;
    if jsonb_typeof(v_question.value -> 'options') is distinct from 'array' then
      raise exception 'Question % must have exactly four answer choices.', v_question.ordinality;
    end if;
    if jsonb_array_length(v_question.value -> 'options') <> 4 then
      raise exception 'Question % must have exactly four answer choices.', v_question.ordinality;
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_question.value -> 'options') as choice(option_value)
      where jsonb_typeof(choice.option_value) is distinct from 'string'
        or length(btrim(choice.option_value #>> '{}')) = 0
        or length(choice.option_value #>> '{}') > 500
    ) then
      raise exception 'Question % needs four answer choices of 1 to 500 characters.', v_question.ordinality;
    end if;
    if v_correct is null or v_correct !~ '^[0-3]$' then
      raise exception 'Question % needs a correct answer from A to D.', v_question.ordinality;
    end if;
    if length(coalesce(v_question.value ->> 'explanation', '')) > 4000 then
      raise exception 'Question % explanation must be 4,000 characters or fewer.', v_question.ordinality;
    end if;
  end loop;

  if v_chapter_id is null then
    insert into public.chapters (stream_id, title, subject)
    values (p_stream_id, btrim(p_title), coalesce(nullif(btrim(p_subject), ''), 'General'))
    returning id into v_chapter_id;
  else
    select * into v_existing from public.chapters c where c.id = v_chapter_id for update;
    if not found or v_existing.stream_id <> p_stream_id or not private.can_manage_stream(v_existing.stream_id) then
      raise exception 'This chapter does not belong to your stream.';
    end if;
    if v_existing.archived_at is not null then raise exception 'Restore this chapter before editing it.'; end if;
    if v_existing.published_at is not null then
      if not coalesce(p_publish, false) then raise exception 'A published chapter must remain published when edited.'; end if;
      insert into private.chapter_edit_context (transaction_id, chapter_id, user_id)
      values (pg_current_xact_id(), v_chapter_id, v_user_id)
      on conflict do nothing;
      update public.challenges c set status = 'cancelled'
      where c.chapter_id = v_chapter_id and c.status = 'pending';
    end if;
    update public.chapters
      set title = btrim(p_title), subject = coalesce(nullif(btrim(p_subject), ''), 'General')
      where id = v_chapter_id;
    delete from public.chapter_classes where chapter_id = v_chapter_id;
    delete from public.chapter_questions where chapter_id = v_chapter_id;
  end if;

  insert into public.chapter_classes (chapter_id, class_id)
  select v_chapter_id, requested.class_id
  from unnest(p_class_ids) as requested(class_id);

  for v_question in
    select item.value, item.ordinality
    from jsonb_array_elements(p_questions) with ordinality as item(value, ordinality)
  loop
    v_position := v_question.ordinality::integer;
    insert into public.chapter_questions (chapter_id, position, prompt, options)
    values (v_chapter_id, v_position, btrim(v_question.value ->> 'prompt'), v_question.value -> 'options')
    returning id into v_question_id;
    insert into public.question_answer_keys (question_id, correct_option_index, explanation)
    values (
      v_question_id,
      (v_question.value ->> 'correct_option_index')::smallint,
      coalesce(v_question.value ->> 'explanation', '')
    );
  end loop;

  if coalesce(p_publish, false) then
    update public.chapters set published_at = clock_timestamp() where id = v_chapter_id;
  end if;
  delete from private.chapter_edit_context
  where transaction_id = pg_current_xact_id() and chapter_id = v_chapter_id and user_id = v_user_id;
  return v_chapter_id;
end;
$$;
create or replace function private.practice_questions(p_chapter_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_questions jsonb;
begin
  if v_user_id is null or not private.is_student_profile(v_user_id) then
    raise exception 'Sign in with a student account to practise.';
  end if;
  if not exists (
    select 1 from public.chapters ch
    where ch.id = p_chapter_id and ch.published_at is not null and private.can_read_chapter(ch.id)
  ) then
    raise exception 'This chapter is not available to your student account.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id,
    'prompt', q.prompt,
    'options', q.options,
    'correct_option_index', k.correct_option_index,
    'explanation', k.explanation
  ) order by q.position), '[]'::jsonb)
  into v_questions
  from public.chapter_questions q
  join public.question_answer_keys k on k.question_id = q.id
  where q.chapter_id = p_chapter_id;
  return v_questions;
end;
$$;
create or replace function private.create_class_invite(p_class_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_code text;
  v_attempt integer;
begin
  if v_user_id is null then raise exception 'Sign in before creating a class invitation.'; end if;
  if not private.can_manage_class(p_class_id) then
    raise exception 'Only the owning teacher can create an invitation for this class.';
  end if;

  for v_attempt in 1..5 loop
    if exists (select 1 from public.classrooms where id = p_class_id and archived_at is not null) then raise exception 'Restore the class before inviting students.'; end if;
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    insert into public.class_invites (code, class_id, created_by)
    values (v_code, p_class_id, v_user_id)
    on conflict (code) do nothing;
    if found then return v_code; end if;
  end loop;

  raise exception 'Could not create a unique class invitation. Please try again.';
end;
$$;
