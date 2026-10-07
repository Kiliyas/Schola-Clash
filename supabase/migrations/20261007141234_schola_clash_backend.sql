-- Schola Clash backend foundation.
-- Apply once to a new Supabase project after reviewing supabase/README.md.
-- Keep the private schema out of the Data API exposed schemas.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create type public.account_role as enum ('teacher', 'student');
create type public.challenge_state as enum ('pending', 'accepted', 'cancelled', 'expired');
create type public.match_state as enum ('active', 'completed', 'forfeit', 'no_contest');

create table public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  role public.account_role not null default 'student',
  created_at timestamptz not null default now()
);

create table public.teacher_streams (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.user_profiles (id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 100),
  created_at timestamptz not null default now()
);

create table public.classrooms (
  id uuid primary key default gen_random_uuid(),
  stream_id uuid not null references public.teacher_streams (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  created_at timestamptz not null default now(),
  unique (stream_id, name),
  unique (id, stream_id)
);

create table public.class_members (
  class_id uuid not null references public.classrooms (id) on delete cascade,
  user_id uuid not null references public.user_profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (class_id, user_id)
);

create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  stream_id uuid not null references public.teacher_streams (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  subject text not null default '' check (length(subject) <= 100),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.chapter_classes (
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  class_id uuid not null references public.classrooms (id) on delete cascade,
  primary key (chapter_id, class_id)
);

-- Students can read question text and choices; answer keys are in a separate
-- RLS-protected table and are never sent to a client before a completed match.
create table public.chapter_questions (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  position integer not null check (position > 0),
  prompt text not null check (length(btrim(prompt)) between 1 and 2000),
  options jsonb not null check (
    jsonb_typeof(options) = 'array'
    and jsonb_array_length(options) = 4
  ),
  created_at timestamptz not null default now(),
  unique (chapter_id, position)
);

create table public.question_answer_keys (
  question_id uuid primary key references public.chapter_questions (id) on delete cascade,
  correct_option_index smallint not null check (correct_option_index between 0 and 3),
  explanation text not null default '' check (length(explanation) <= 4000)
);

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references public.chapters (id) on delete restrict,
  challenger_id uuid not null references public.user_profiles (id) on delete restrict,
  opponent_id uuid not null references public.user_profiles (id) on delete restrict,
  status public.challenge_state not null default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '3 hours'),
  accepted_at timestamptz,
  check (challenger_id <> opponent_id)
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null unique references public.challenges (id) on delete restrict,
  chapter_id uuid not null references public.chapters (id) on delete restrict,
  stream_id uuid not null references public.teacher_streams (id) on delete restrict,
  player_one_id uuid not null references public.user_profiles (id) on delete restrict,
  player_two_id uuid not null references public.user_profiles (id) on delete restrict,
  status public.match_state not null default 'active',
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null default (now() + interval '24 hours'),
  resolved_at timestamptz,
  winner_id uuid references public.user_profiles (id) on delete restrict,
  forfeit_by uuid references public.user_profiles (id) on delete restrict,
  rating_applied boolean not null default false,
  rating_before jsonb,
  rating_changes jsonb,
  check (player_one_id <> player_two_id),
  check (winner_id is null or winner_id in (player_one_id, player_two_id)),
  check (forfeit_by is null or forfeit_by in (player_one_id, player_two_id))
);

-- Match content and keys are snapshots, so chapter edits cannot change a duel.
create table public.match_questions (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  source_question_id uuid references public.chapter_questions (id) on delete set null,
  position integer not null check (position > 0),
  prompt text not null,
  options jsonb not null check (
    jsonb_typeof(options) = 'array'
    and jsonb_array_length(options) = 4
  ),
  unique (match_id, position)
);

create table public.match_question_keys (
  match_question_id uuid primary key references public.match_questions (id) on delete cascade,
  correct_option_index smallint not null check (correct_option_index between 0 and 3),
  explanation text not null default ''
);

create table public.match_player_questions (
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.user_profiles (id) on delete cascade,
  match_question_id uuid not null references public.match_questions (id) on delete cascade,
  display_order jsonb not null check (
    jsonb_typeof(display_order) = 'array'
    and jsonb_array_length(display_order) = 4
  ),
  primary key (match_id, user_id, match_question_id)
);

create table public.match_attempts (
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.user_profiles (id) on delete cascade,
  answers jsonb not null default '[]'::jsonb check (jsonb_typeof(answers) = 'array'),
  submitted_at timestamptz,
  primary key (match_id, user_id)
);

create table public.stream_ratings (
  stream_id uuid not null references public.teacher_streams (id) on delete cascade,
  user_id uuid not null references public.user_profiles (id) on delete cascade,
  rating integer not null default 1000 check (rating >= 0),
  updated_at timestamptz not null default now(),
  primary key (stream_id, user_id)
);

create index classrooms_stream_idx on public.classrooms (stream_id);
create index class_members_user_idx on public.class_members (user_id, class_id);
create index chapters_stream_idx on public.chapters (stream_id, published_at);
create index chapter_classes_class_idx on public.chapter_classes (class_id, chapter_id);
create index chapter_questions_chapter_idx on public.chapter_questions (chapter_id, position);
create index challenges_participants_idx on public.challenges (challenger_id, opponent_id, status);
create index matches_chapter_players_idx on public.matches (chapter_id, player_one_id, player_two_id);
create index matches_deadline_idx on public.matches (deadline_at) where status = 'active';
create index match_attempts_user_idx on public.match_attempts (user_id, match_id);
create index stream_ratings_user_idx on public.stream_ratings (user_id, stream_id);

create or replace function private.is_teacher_profile(p_user_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.id = p_user_id and p.role = 'teacher'
  );
$$;

create or replace function private.is_student_profile(p_user_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.id = p_user_id and p.role = 'student'
  );
$$;

create or replace function private.can_manage_stream(p_stream_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.teacher_streams s
    where s.id = p_stream_id
      and s.owner_user_id = (select auth.uid())
      and private.is_teacher_profile(s.owner_user_id)
  );
$$;

create or replace function private.can_access_stream(p_stream_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select private.can_manage_stream(p_stream_id) or exists (
    select 1
    from public.classrooms c
    join public.class_members cm on cm.class_id = c.id
    where c.stream_id = p_stream_id and cm.user_id = (select auth.uid())
  );
$$;

create or replace function private.can_manage_class(p_class_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.classrooms c
    where c.id = p_class_id and private.can_manage_stream(c.stream_id)
  );
$$;

create or replace function private.can_access_class(p_class_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select private.can_manage_class(p_class_id) or exists (
    select 1 from public.class_members cm
    where cm.class_id = p_class_id and cm.user_id = (select auth.uid())
  );
$$;

create or replace function private.can_view_profile(p_profile_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select p_profile_id = (select auth.uid()) or exists (
    select 1
    from public.class_members target_member
    join public.classrooms target_class on target_class.id = target_member.class_id
    where target_member.user_id = p_profile_id
      and private.can_access_stream(target_class.stream_id)
  ) or exists (
    select 1 from public.teacher_streams s
    where s.owner_user_id = p_profile_id and private.can_access_stream(s.id)
  );
$$;

create or replace function private.can_read_chapter(p_chapter_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.chapters ch
    where ch.id = p_chapter_id and (
      private.can_manage_stream(ch.stream_id)
      or (ch.published_at is not null and exists (
        select 1
        from public.chapter_classes cc
        join public.class_members cm on cm.class_id = cc.class_id
        where cc.chapter_id = ch.id and cm.user_id = (select auth.uid())
      ))
    )
  );
$$;

create or replace function private.can_read_match(p_match_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.matches m
    where m.id = p_match_id and (
      m.player_one_id = (select auth.uid())
      or m.player_two_id = (select auth.uid())
      or private.can_manage_stream(m.stream_id)
    )
  );
$$;

create or replace function private.can_review_match(p_match_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.matches m
    where m.id = p_match_id and (
      private.can_manage_stream(m.stream_id)
      or (
        m.status = 'completed'
        and (m.player_one_id = (select auth.uid()) or m.player_two_id = (select auth.uid()))
      )
    )
  );
$$;

create or replace function private.can_read_attempt(p_match_id uuid, p_user_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select p_user_id = (select auth.uid()) or private.can_review_match(p_match_id);
$$;

create or replace function private.handle_new_auth_user()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'Student'),
    case when new.raw_app_meta_data ->> 'role' = 'teacher'
      then 'teacher'::public.account_role else 'student'::public.account_role end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_auth_user();

create or replace function private.enforce_chapter_publication()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  v_question_count integer;
  v_key_count integer;
begin
  if new.published_at is null then return new; end if;
  select count(*) into v_question_count
  from public.chapter_questions q where q.chapter_id = new.id;
  select count(*) into v_key_count
  from public.chapter_questions q
  join public.question_answer_keys k on k.question_id = q.id
  where q.chapter_id = new.id;
  if v_question_count < 15 or v_key_count <> v_question_count then
    raise exception 'A ranked chapter needs at least 15 questions, each with an answer key.';
  end if;
  return new;
end;
$$;

create trigger chapters_require_complete_questions
before insert or update of published_at on public.chapters
for each row execute function private.enforce_chapter_publication();

create or replace function private.prevent_question_insert_into_published_chapter()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.chapters ch where ch.id = new.chapter_id and ch.published_at is not null
  ) then
    raise exception 'Unpublish a chapter before adding questions.';
  end if;
  return new;
end;
$$;

create trigger published_chapter_questions_are_stable
before insert on public.chapter_questions
for each row execute function private.prevent_question_insert_into_published_chapter();

create or replace function private.guard_published_chapter_minimum()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if tg_op = 'UPDATE' and old.chapter_id <> new.chapter_id
    and exists (
      select 1 from public.chapters ch
      where ch.id in (old.chapter_id, new.chapter_id) and ch.published_at is not null
    ) then
    raise exception 'Unpublish a chapter before moving its questions.';
  end if;
  if exists (select 1 from public.chapters ch where ch.id = old.chapter_id and ch.published_at is not null) then
    select count(*) into v_count from public.chapter_questions q where q.chapter_id = old.chapter_id;
    if v_count < 15 then raise exception 'A published chapter must keep at least 15 questions.'; end if;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger published_chapters_keep_minimum
after delete or update of chapter_id on public.chapter_questions
for each row execute function private.guard_published_chapter_minimum();

create or replace function private.guard_published_question_key()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and exists (
    select 1 from public.chapter_questions q
    join public.chapters ch on ch.id = q.chapter_id
    where q.id = old.question_id and ch.published_at is not null
  ) then
    raise exception 'Unpublish a chapter before removing or moving an answer key.';
  end if;
  if tg_op = 'UPDATE' and old.question_id <> new.question_id and exists (
    select 1 from public.chapter_questions q
    join public.chapters ch on ch.id = q.chapter_id
    where q.id = old.question_id and ch.published_at is not null
  ) then
    raise exception 'Unpublish a chapter before removing or moving an answer key.';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger published_question_keys_stay_attached
before delete or update of question_id on public.question_answer_keys
for each row execute function private.guard_published_question_key();

create or replace function private.check_chapter_class_stream()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.chapters ch
    join public.classrooms c on c.stream_id = ch.stream_id
    where ch.id = new.chapter_id and c.id = new.class_id
  ) then
    raise exception 'The chapter and class must belong to the same teacher stream.';
  end if;
  return new;
end;
$$;

create trigger chapter_class_stream_matches
before insert or update on public.chapter_classes
for each row execute function private.check_chapter_class_stream();

create or replace function private.check_membership_student()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_student_profile(new.user_id) then
    raise exception 'Only student accounts can join a class.';
  end if;
  return new;
end;
$$;

create trigger class_members_are_students
before insert or update of user_id on public.class_members
for each row execute function private.check_membership_student();

create or replace function private.touch_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger chapters_touch_updated_at
before update on public.chapters
for each row execute function private.touch_updated_at();

-- Advisory locks serialize per-student/per-chapter limit checks.
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
  if not exists (
    select 1 from public.chapters ch
    where ch.id = p_chapter_id and ch.published_at is not null
      and private.is_student_profile(v_user_id)
      and private.is_student_profile(p_opponent_id)
      and exists (
        select 1 from public.chapter_classes cc
        join public.class_members cm on cm.class_id = cc.class_id
        where cc.chapter_id = ch.id and cm.user_id = v_user_id
      )
      and exists (
        select 1 from public.chapter_classes cc
        join public.class_members cm on cm.class_id = cc.class_id
        where cc.chapter_id = ch.id and cm.user_id = p_opponent_id
      )
  ) then
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
    select 1 from public.matches m
    where m.chapter_id = p_chapter_id
      and (m.player_one_id in (v_user_id, p_opponent_id) or m.player_two_id in (v_user_id, p_opponent_id))
    group by case when m.player_one_id in (v_user_id, p_opponent_id) then m.player_one_id else m.player_two_id end
    having count(*) >= 3
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
returns jsonb language plpgsql security definer
set search_path = ''
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
    select u.user_id
    from unnest(array[v_challenge.challenger_id, v_challenge.opponent_id]) as u(user_id)
    order by u.user_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_user::text || ':' || v_challenge.chapter_id::text, 0));
  end loop;

  select * into v_chapter from public.chapters ch
  where ch.id = v_challenge.chapter_id and ch.published_at is not null;
  if not found then raise exception 'This chapter is no longer published.'; end if;

  select not exists (
    select 1 from public.matches m
    where m.chapter_id = v_challenge.chapter_id
      and (m.player_one_id in (v_challenge.challenger_id, v_challenge.opponent_id)
        or m.player_two_id in (v_challenge.challenger_id, v_challenge.opponent_id))
    group by case when m.player_one_id in (v_challenge.challenger_id, v_challenge.opponent_id)
      then m.player_one_id else m.player_two_id end
    having count(*) >= 3
  ) into v_has_room;
  if not v_has_room then return jsonb_build_object('status', 'match_limit_reached'); end if;

  select count(*) into v_question_count from public.chapter_questions q where q.chapter_id = v_challenge.chapter_id;
  v_match_size := least(v_question_count, greatest(5, floor(v_question_count::numeric / 3)::integer));

  insert into public.matches (
    challenge_id, chapter_id, stream_id, player_one_id, player_two_id, started_at, deadline_at
  ) values (
    v_challenge.id, v_challenge.chapter_id, v_chapter.stream_id,
    v_challenge.challenger_id, v_challenge.opponent_id, v_now, v_now + interval '24 hours'
  ) returning id into v_match_id;

  insert into public.stream_ratings (stream_id, user_id)
  values (v_chapter.stream_id, v_challenge.challenger_id), (v_chapter.stream_id, v_challenge.opponent_id)
  on conflict (stream_id, user_id) do nothing;

  insert into public.match_attempts (match_id, user_id)
  values (v_match_id, v_challenge.challenger_id), (v_match_id, v_challenge.opponent_id);

  for v_question in
    select q.id, q.prompt, q.options, k.correct_option_index, k.explanation
    from public.chapter_questions q
    join public.question_answer_keys k on k.question_id = q.id
    where q.chapter_id = v_challenge.chapter_id
    order by random()
    limit v_match_size
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
  return jsonb_build_object('status', 'active', 'match_id', v_match_id, 'deadline_at', v_now + interval '24 hours');
end;
$$;

create or replace function private.cancel_challenge(p_challenge_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_challenge public.challenges%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'Sign in before cancelling an invitation.'; end if;
  select * into v_challenge from public.challenges c where c.id = p_challenge_id for update;
  if not found or v_challenge.challenger_id <> (select auth.uid()) then
    raise exception 'Only the student who sent an invitation can cancel it.';
  end if;
  if v_challenge.status <> 'pending' then
    return jsonb_build_object('status', v_challenge.status::text);
  end if;
  if v_challenge.expires_at <= clock_timestamp() then
    update public.challenges set status = 'expired' where id = p_challenge_id;
    return jsonb_build_object('status', 'expired');
  end if;
  update public.challenges set status = 'cancelled' where id = p_challenge_id;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

create or replace function private.resolve_match_deadline(p_match_id uuid)
returns text language plpgsql security definer
set search_path = ''
as $$
declare
  v_match public.matches%rowtype;
  v_one_submitted boolean;
  v_two_submitted boolean;
begin
  select * into v_match from public.matches m where m.id = p_match_id for update;
  if not found then raise exception 'Match not found.'; end if;
  if (select auth.uid()) is null or (
    v_match.player_one_id <> (select auth.uid())
    and v_match.player_two_id <> (select auth.uid())
    and not private.can_manage_stream(v_match.stream_id)
  ) then raise exception 'You cannot resolve this match.'; end if;
  if v_match.status <> 'active' or clock_timestamp() < v_match.deadline_at then
    return v_match.status::text;
  end if;

  select coalesce(bool_or(a.user_id = v_match.player_one_id and a.submitted_at is not null), false),
         coalesce(bool_or(a.user_id = v_match.player_two_id and a.submitted_at is not null), false)
    into v_one_submitted, v_two_submitted
  from public.match_attempts a where a.match_id = p_match_id;

  if v_one_submitted and v_two_submitted then
    return v_match.status::text;
  elsif v_one_submitted or v_two_submitted then
    update public.matches
    set status = 'forfeit',
        winner_id = case when v_one_submitted then v_match.player_one_id else v_match.player_two_id end,
        forfeit_by = case when v_one_submitted then v_match.player_two_id else v_match.player_one_id end,
        resolved_at = clock_timestamp()
    where id = p_match_id;
    return 'forfeit';
  else
    update public.matches set status = 'no_contest', resolved_at = clock_timestamp() where id = p_match_id;
    return 'no_contest';
  end if;
end;
$$;

create or replace function private.refresh_match(p_match_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_match public.matches%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'Sign in to view a match.'; end if;
  select * into v_match from public.matches m where m.id = p_match_id for update;
  if not found or (
    v_match.player_one_id <> (select auth.uid())
    and v_match.player_two_id <> (select auth.uid())
    and not private.can_manage_stream(v_match.stream_id)
  ) then raise exception 'You cannot view this match.'; end if;
  perform private.resolve_match_deadline(p_match_id);
  select * into v_match from public.matches m where m.id = p_match_id;
  return jsonb_build_object(
    'id', v_match.id, 'status', v_match.status::text, 'deadline_at', v_match.deadline_at,
    'winner_id', v_match.winner_id, 'forfeit_by', v_match.forfeit_by,
    'rating_before', v_match.rating_before, 'rating_changes', v_match.rating_changes
  );
end;
$$;

create or replace function private.submit_match_answers(p_match_id uuid, p_answers jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_match public.matches%rowtype;
  v_attempt public.match_attempts%rowtype;
  v_answer_index integer;
  v_answer_text text;
  v_question_count integer;
  v_one_score integer;
  v_two_score integer;
  v_one_rating integer;
  v_two_rating integer;
  v_actual numeric;
  v_expected numeric;
  v_change integer;
  v_winner uuid;
  v_now timestamptz;
begin
  if v_user_id is null then raise exception 'Sign in before submitting answers.'; end if;
  select * into v_match from public.matches m where m.id = p_match_id for update;
  if not found or v_user_id not in (v_match.player_one_id, v_match.player_two_id) then
    raise exception 'This match does not belong to the signed-in student.';
  end if;
  v_now := clock_timestamp();

  if v_match.status = 'active' and v_now >= v_match.deadline_at then
    perform private.resolve_match_deadline(p_match_id);
    select * into v_match from public.matches m where m.id = p_match_id;
    return jsonb_build_object('status', v_match.status::text, 'winner_id', v_match.winner_id, 'forfeit_by', v_match.forfeit_by);
  end if;
  if v_match.status <> 'active' then
    return jsonb_build_object('status', v_match.status::text, 'winner_id', v_match.winner_id);
  end if;

  select count(*) into v_question_count from public.match_questions q where q.match_id = p_match_id;
  if jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception 'Answers must be submitted as an array.';
  end if;
  if jsonb_array_length(p_answers) <> v_question_count then
    raise exception 'Submit one answer for every question.';
  end if;
  for v_answer_index in 0..(v_question_count - 1) loop
    v_answer_text := p_answers ->> v_answer_index;
    if v_answer_text is null or v_answer_text !~ '^[0-3]$' then
      raise exception 'Each answer must be a choice from 0 to 3.';
    end if;
  end loop;

  select * into v_attempt from public.match_attempts a
  where a.match_id = p_match_id and a.user_id = v_user_id for update;
  if v_attempt.submitted_at is not null then raise exception 'Answers for this match have already been submitted.'; end if;
  update public.match_attempts set answers = p_answers, submitted_at = v_now
  where match_id = p_match_id and user_id = v_user_id;

  if exists (
    select 1 from public.match_attempts a
    where a.match_id = p_match_id and a.user_id <> v_user_id and a.submitted_at is null
  ) then
    return jsonb_build_object('status', 'active', 'submitted', true, 'waiting_for_opponent', true);
  end if;

  select count(*) into v_one_score
  from public.match_questions q
  join public.match_question_keys k on k.match_question_id = q.id
  join public.match_attempts a on a.match_id = q.match_id and a.user_id = v_match.player_one_id
  join public.match_player_questions pq on pq.match_id = q.match_id and pq.match_question_id = q.id and pq.user_id = v_match.player_one_id
  where q.match_id = p_match_id
    and (pq.display_order ->> ((a.answers ->> (q.position - 1))::integer))::integer = k.correct_option_index;

  select count(*) into v_two_score
  from public.match_questions q
  join public.match_question_keys k on k.match_question_id = q.id
  join public.match_attempts a on a.match_id = q.match_id and a.user_id = v_match.player_two_id
  join public.match_player_questions pq on pq.match_id = q.match_id and pq.match_question_id = q.id and pq.user_id = v_match.player_two_id
  where q.match_id = p_match_id
    and (pq.display_order ->> ((a.answers ->> (q.position - 1))::integer))::integer = k.correct_option_index;

  v_winner := case when v_one_score = v_two_score then null
                   when v_one_score > v_two_score then v_match.player_one_id
                   else v_match.player_two_id end;
  v_actual := case when v_one_score = v_two_score then 0.5
                   when v_one_score > v_two_score then 1.0 else 0.0 end;

  perform r.user_id from public.stream_ratings r
  where r.stream_id = v_match.stream_id
    and r.user_id in (v_match.player_one_id, v_match.player_two_id)
  order by r.user_id for update;
  select r.rating into v_one_rating from public.stream_ratings r
  where r.stream_id = v_match.stream_id and r.user_id = v_match.player_one_id;
  select r.rating into v_two_rating from public.stream_ratings r
  where r.stream_id = v_match.stream_id and r.user_id = v_match.player_two_id;
  v_expected := 1.0 / (1.0 + power(10.0, (v_two_rating - v_one_rating)::numeric / 400.0));
  v_change := round(32 * (v_actual - v_expected))::integer;

  update public.stream_ratings set rating = rating + v_change, updated_at = v_now
  where stream_id = v_match.stream_id and user_id = v_match.player_one_id;
  update public.stream_ratings set rating = rating - v_change, updated_at = v_now
  where stream_id = v_match.stream_id and user_id = v_match.player_two_id;

  update public.matches
  set status = 'completed', resolved_at = v_now, winner_id = v_winner, rating_applied = true,
      rating_before = jsonb_build_object(v_match.player_one_id::text, v_one_rating, v_match.player_two_id::text, v_two_rating),
      rating_changes = jsonb_build_object(v_match.player_one_id::text, v_change, v_match.player_two_id::text, -v_change)
  where id = p_match_id;

  return jsonb_build_object(
    'status', 'completed', 'winner_id', v_winner,
    'scores', jsonb_build_object(v_match.player_one_id::text, v_one_score, v_match.player_two_id::text, v_two_score),
    'rating_before', jsonb_build_object(v_match.player_one_id::text, v_one_rating, v_match.player_two_id::text, v_two_rating),
    'rating_changes', jsonb_build_object(v_match.player_one_id::text, v_change, v_match.player_two_id::text, -v_change)
  );
end;
$$;

-- Public RPC wrappers are invoker-rights; internal routines validate auth.uid().
create or replace function public.create_challenge(p_chapter_id uuid, p_opponent_id uuid)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_challenge(p_chapter_id, p_opponent_id); $$;

create or replace function public.accept_challenge(p_challenge_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.accept_challenge(p_challenge_id); $$;

create or replace function public.cancel_challenge(p_challenge_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.cancel_challenge(p_challenge_id); $$;

create or replace function public.refresh_match(p_match_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.refresh_match(p_match_id); $$;

create or replace function public.submit_match_answers(p_match_id uuid, p_answers jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.submit_match_answers(p_match_id, p_answers); $$;

alter table public.user_profiles enable row level security;
alter table public.teacher_streams enable row level security;
alter table public.classrooms enable row level security;
alter table public.class_members enable row level security;
alter table public.chapters enable row level security;
alter table public.chapter_classes enable row level security;
alter table public.chapter_questions enable row level security;
alter table public.question_answer_keys enable row level security;
alter table public.challenges enable row level security;
alter table public.matches enable row level security;
alter table public.match_questions enable row level security;
alter table public.match_question_keys enable row level security;
alter table public.match_player_questions enable row level security;
alter table public.match_attempts enable row level security;
alter table public.stream_ratings enable row level security;

create policy profiles_read_shared_class on public.user_profiles
for select to authenticated using (private.can_view_profile(id));
create policy profiles_update_self on public.user_profiles
for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy streams_read_member on public.teacher_streams
for select to authenticated using (private.can_access_stream(id));
create policy streams_create_teacher on public.teacher_streams
for insert to authenticated with check (owner_user_id = (select auth.uid()) and private.is_teacher_profile(owner_user_id));
create policy streams_update_owner on public.teacher_streams
for update to authenticated using (private.can_manage_stream(id)) with check (private.can_manage_stream(id));

create policy classrooms_read_member on public.classrooms
for select to authenticated using (private.can_access_class(id));
create policy classrooms_create_teacher on public.classrooms
for insert to authenticated with check (private.can_manage_stream(stream_id));
create policy classrooms_update_teacher on public.classrooms
for update to authenticated using (private.can_manage_stream(stream_id)) with check (private.can_manage_stream(stream_id));
create policy classrooms_delete_teacher on public.classrooms
for delete to authenticated using (private.can_manage_stream(stream_id));

create policy class_members_read_self_or_teacher on public.class_members
for select to authenticated using (user_id = (select auth.uid()) or private.can_access_class(class_id));
create policy class_members_add_teacher on public.class_members
for insert to authenticated with check (private.can_manage_class(class_id) and private.is_student_profile(user_id));
create policy class_members_remove_teacher on public.class_members
for delete to authenticated using (private.can_manage_class(class_id));

create policy chapters_read_assigned on public.chapters
for select to authenticated using (private.can_read_chapter(id));
create policy chapters_create_teacher on public.chapters
for insert to authenticated with check (private.can_manage_stream(stream_id));
create policy chapters_update_teacher on public.chapters
for update to authenticated using (private.can_manage_stream(stream_id)) with check (private.can_manage_stream(stream_id));
create policy chapters_delete_teacher on public.chapters
for delete to authenticated using (private.can_manage_stream(stream_id));

create policy chapter_classes_read_assigned on public.chapter_classes
for select to authenticated using (private.can_read_chapter(chapter_id));
create policy chapter_classes_manage_teacher on public.chapter_classes
for all to authenticated using (
  exists (select 1 from public.chapters ch where ch.id = chapter_id and private.can_manage_stream(ch.stream_id))
) with check (
  exists (select 1 from public.chapters ch where ch.id = chapter_id and private.can_manage_stream(ch.stream_id))
);

create policy chapter_questions_read_assigned on public.chapter_questions
for select to authenticated using (private.can_read_chapter(chapter_id));
create policy chapter_questions_manage_teacher on public.chapter_questions
for all to authenticated using (
  exists (select 1 from public.chapters ch where ch.id = chapter_id and private.can_manage_stream(ch.stream_id))
) with check (
  exists (select 1 from public.chapters ch where ch.id = chapter_id and private.can_manage_stream(ch.stream_id))
);

create policy question_keys_teacher_only on public.question_answer_keys
for all to authenticated using (
  exists (
    select 1 from public.chapter_questions q join public.chapters ch on ch.id = q.chapter_id
    where q.id = question_id and private.can_manage_stream(ch.stream_id)
  )
) with check (
  exists (
    select 1 from public.chapter_questions q join public.chapters ch on ch.id = q.chapter_id
    where q.id = question_id and private.can_manage_stream(ch.stream_id)
  )
);

create policy challenges_read_parties_or_teacher on public.challenges
for select to authenticated using (
  challenger_id = (select auth.uid()) or opponent_id = (select auth.uid())
  or exists (select 1 from public.chapters ch where ch.id = chapter_id and private.can_manage_stream(ch.stream_id))
);

create policy matches_read_participants_or_teacher on public.matches
for select to authenticated using (private.can_read_match(id));
create policy match_questions_read_participants_or_teacher on public.match_questions
for select to authenticated using (private.can_read_match(match_id));
create policy match_keys_after_completion on public.match_question_keys
for select to authenticated using (
  exists (select 1 from public.match_questions q where q.id = match_question_id and private.can_review_match(q.match_id))
);
create policy player_question_order_read_self on public.match_player_questions
for select to authenticated using (user_id = (select auth.uid()));
create policy attempts_read_self_or_completed on public.match_attempts
for select to authenticated using (private.can_read_attempt(match_id, user_id));
create policy ratings_read_stream on public.stream_ratings
for select to authenticated using (private.can_access_stream(stream_id));

-- Remove any broad default grants on these tables before assigning the UI's access.
revoke all on public.user_profiles, public.teacher_streams, public.classrooms, public.class_members,
  public.chapters, public.chapter_classes, public.chapter_questions, public.question_answer_keys,
  public.challenges, public.matches, public.match_questions, public.match_question_keys,
  public.match_player_questions, public.match_attempts, public.stream_ratings from anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.user_profiles, public.teacher_streams, public.classrooms, public.class_members,
  public.chapters, public.chapter_classes, public.chapter_questions, public.question_answer_keys,
  public.challenges, public.matches, public.match_questions, public.match_question_keys,
  public.match_player_questions, public.match_attempts, public.stream_ratings to authenticated;
grant update (display_name) on public.user_profiles to authenticated;
grant insert on public.teacher_streams, public.classrooms, public.class_members,
  public.chapters, public.chapter_classes, public.chapter_questions, public.question_answer_keys to authenticated;
grant delete on public.classrooms, public.class_members, public.chapters,
  public.chapter_classes, public.chapter_questions, public.question_answer_keys to authenticated;
grant update (name) on public.teacher_streams, public.classrooms to authenticated;
grant update (title, subject, published_at) on public.chapters to authenticated;
grant update (position, prompt, options) on public.chapter_questions to authenticated;
grant update (correct_option_index, explanation) on public.question_answer_keys to authenticated;

revoke all on all functions in schema private from public, anon;
grant execute on function private.is_teacher_profile(uuid), private.is_student_profile(uuid),
  private.can_manage_stream(uuid), private.can_access_stream(uuid), private.can_manage_class(uuid),
  private.can_access_class(uuid), private.can_view_profile(uuid), private.can_read_chapter(uuid),
  private.can_read_match(uuid), private.can_review_match(uuid), private.can_read_attempt(uuid, uuid),
  private.create_challenge(uuid, uuid), private.accept_challenge(uuid), private.cancel_challenge(uuid),
  private.resolve_match_deadline(uuid),
  private.refresh_match(uuid), private.submit_match_answers(uuid, jsonb) to authenticated;

revoke all on function public.create_challenge(uuid, uuid), public.accept_challenge(uuid),
  public.cancel_challenge(uuid),
  public.refresh_match(uuid), public.submit_match_answers(uuid, jsonb) from public, anon;
grant execute on function public.create_challenge(uuid, uuid), public.accept_challenge(uuid),
  public.cancel_challenge(uuid),
  public.refresh_match(uuid), public.submit_match_answers(uuid, jsonb) to authenticated;
