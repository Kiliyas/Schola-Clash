-- Allow safe edits to published chapters, provide scoped practice data, and report scores.
create table private.chapter_edit_context (
  transaction_id xid8 not null,
  chapter_id uuid not null,
  user_id uuid not null,
  primary key (transaction_id, chapter_id, user_id)
);
alter table private.chapter_edit_context enable row level security;
revoke all on table private.chapter_edit_context from public, anon, authenticated;

create or replace function private.has_published_chapter_edit(p_chapter_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.chapter_edit_context context_row
    where context_row.transaction_id = pg_current_xact_id_if_assigned()
      and context_row.chapter_id = p_chapter_id
      and context_row.user_id = (select auth.uid())
  );
$$;
revoke all on function private.has_published_chapter_edit(uuid) from public, anon, authenticated;

create or replace function private.prevent_question_insert_into_published_chapter()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from public.chapters ch
    where ch.id = new.chapter_id and ch.published_at is not null
  ) and not private.has_published_chapter_edit(new.chapter_id) then
    raise exception 'Published chapters can only be edited through the owner chapter editor.';
  end if;
  return new;
end;
$$;

create or replace function private.guard_published_chapter_minimum()
returns trigger language plpgsql security definer set search_path = ''
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
  if exists (select 1 from public.chapters ch where ch.id = old.chapter_id and ch.published_at is not null)
    and not private.has_published_chapter_edit(old.chapter_id) then
    select count(*) into v_count from public.chapter_questions q where q.chapter_id = old.chapter_id;
    if v_count < 15 then raise exception 'A published chapter must keep at least 15 questions.'; end if;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create or replace function private.guard_published_question_key()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and exists (
    select 1 from public.chapter_questions q
    join public.chapters ch on ch.id = q.chapter_id
    where q.id = old.question_id and ch.published_at is not null
      and not private.has_published_chapter_edit(ch.id)
  ) then
    raise exception 'Published chapter answer keys can only be edited through the owner chapter editor.';
  end if;
  if tg_op = 'UPDATE' and old.question_id <> new.question_id and exists (
    select 1 from public.chapter_questions q
    join public.chapters ch on ch.id = q.chapter_id
    where q.id = old.question_id and ch.published_at is not null
      and not private.has_published_chapter_edit(ch.id)
  ) then
    raise exception 'Published chapter answer keys can only be moved through the owner chapter editor.';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

-- Keep the existing atomic save validations and use a transaction-scoped owner marker
-- while replacing the published chapter rows. Match snapshots remain independent.
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
  join public.classrooms c on c.id = requested.class_id and c.stream_id = p_stream_id;
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

create or replace function private.remove_student_from_class(p_class_id uuid, p_student_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_removed integer;
begin
  if v_user_id is null then raise exception 'Sign in before managing class members.'; end if;
  if not private.can_manage_class(p_class_id) then raise exception 'Only the class owner can remove students.'; end if;
  if not private.is_student_profile(p_student_id) then raise exception 'Only student accounts can be removed from a class.'; end if;
  delete from public.class_members cm where cm.class_id = p_class_id and cm.user_id = p_student_id;
  get diagnostics v_removed = row_count;
  update public.challenges c set status = 'cancelled'
  where c.status = 'pending'
    and p_student_id in (c.challenger_id, c.opponent_id)
    and exists (
      select 1 from public.chapter_classes cc
      where cc.chapter_id = c.chapter_id and cc.class_id = p_class_id
    )
    and not exists (
      select 1 from public.chapter_classes cc
      join public.class_members cm on cm.class_id = cc.class_id
      where cc.chapter_id = c.chapter_id and cm.user_id = p_student_id
    );
  return jsonb_build_object('removed', v_removed = 1);
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

create or replace function private.match_player_score(p_match_id uuid, p_user_id uuid)
returns integer language sql stable security definer set search_path = ''
as $$
  select case
    when m.status not in ('completed', 'forfeit') or a.submitted_at is null then null
    else (
      select count(*)::integer
      from public.match_questions q
      join public.match_question_keys k on k.match_question_id = q.id
      join public.match_player_questions pq on pq.match_id = q.match_id
        and pq.match_question_id = q.id and pq.user_id = p_user_id
      where q.match_id = p_match_id
        and (pq.display_order ->> ((a.answers ->> (q.position - 1))::integer))::integer = k.correct_option_index
    )
  end
  from public.matches m
  left join public.match_attempts a on a.match_id = m.id and a.user_id = p_user_id
  where m.id = p_match_id and p_user_id in (m.player_one_id, m.player_two_id);
$$;
revoke all on function private.match_player_score(uuid, uuid) from public, anon, authenticated;

create or replace function private.refresh_match(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_match public.matches%rowtype;
  v_scores jsonb;
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
  if v_match.status in ('completed', 'forfeit') then
    v_scores := jsonb_build_object(
      v_match.player_one_id::text, private.match_player_score(p_match_id, v_match.player_one_id),
      v_match.player_two_id::text, private.match_player_score(p_match_id, v_match.player_two_id)
    );
  end if;
  return jsonb_build_object(
    'id', v_match.id, 'status', v_match.status::text, 'deadline_at', v_match.deadline_at,
    'winner_id', v_match.winner_id, 'forfeit_by', v_match.forfeit_by,
    'rating_before', v_match.rating_before, 'rating_changes', v_match.rating_changes,
    'scores', v_scores
  );
end;
$$;

create or replace function private.teacher_chapter_progress(p_stream_id uuid)
returns table (
  chapter_id uuid,
  user_id uuid,
  match_count bigint,
  submitted_count bigint,
  correct_count bigint,
  question_count bigint,
  win_count bigint
)
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null or not private.can_manage_stream(p_stream_id) then
    raise exception 'Only the stream owner can view chapter progress.';
  end if;
  return query
  with score_rows as (
    select m.chapter_id, m.id as match_id, m.status, m.winner_id, a.user_id, a.submitted_at,
      case when m.status in ('completed', 'forfeit') and a.submitted_at is not null
        then private.match_player_score(m.id, a.user_id) end as correct_count,
      case when m.status in ('completed', 'forfeit') and a.submitted_at is not null
        then (select count(*)::integer from public.match_questions q where q.match_id = m.id)
        else 0 end as question_count
    from public.matches m
    join public.match_attempts a on a.match_id = m.id
    where m.stream_id = p_stream_id
  )
  select score_rows.chapter_id, score_rows.user_id,
    count(*)::bigint,
    (count(*) filter (where score_rows.submitted_at is not null))::bigint,
    coalesce(sum(score_rows.correct_count), 0)::bigint,
    coalesce(sum(score_rows.question_count), 0)::bigint,
    (count(*) filter (where score_rows.winner_id = score_rows.user_id))::bigint
  from score_rows
  group by score_rows.chapter_id, score_rows.user_id;
end;
$$;

create or replace function public.remove_student_from_class(p_class_id uuid, p_student_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.remove_student_from_class(p_class_id, p_student_id); $$;

create or replace function public.get_practice_questions(p_chapter_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.practice_questions(p_chapter_id); $$;

create or replace function public.get_teacher_chapter_progress(p_stream_id uuid)
returns table (
  chapter_id uuid,
  user_id uuid,
  match_count bigint,
  submitted_count bigint,
  correct_count bigint,
  question_count bigint,
  win_count bigint
)
language sql security invoker set search_path = ''
as $$ select * from private.teacher_chapter_progress(p_stream_id); $$;

revoke all on function private.remove_student_from_class(uuid, uuid) from public, anon;
grant execute on function private.remove_student_from_class(uuid, uuid) to authenticated;
revoke all on function private.practice_questions(uuid) from public, anon;
grant execute on function private.practice_questions(uuid) to authenticated;
revoke all on function private.teacher_chapter_progress(uuid) from public, anon;
grant execute on function private.teacher_chapter_progress(uuid) to authenticated;
revoke all on function public.remove_student_from_class(uuid, uuid) from public, anon;
grant execute on function public.remove_student_from_class(uuid, uuid) to authenticated;
revoke all on function public.get_practice_questions(uuid) from public, anon;
grant execute on function public.get_practice_questions(uuid) to authenticated;
revoke all on function public.get_teacher_chapter_progress(uuid) from public, anon;
grant execute on function public.get_teacher_chapter_progress(uuid) to authenticated;
