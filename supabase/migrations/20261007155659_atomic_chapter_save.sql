-- Create the initial stream and its classes as a single transaction.
create or replace function private.create_teacher_space(p_name text, p_class_names text[])
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_stream_id uuid;
  v_class_name text;
  v_duplicate_count integer;
begin
  if v_user_id is null then raise exception 'Sign in before creating a teaching space.'; end if;
  if not private.is_teacher_profile(v_user_id) then
    raise exception 'Only teacher accounts can create a teaching space.';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 100 then
    raise exception 'Enter a teaching space name of 1 to 100 characters.';
  end if;
  if p_class_names is null or cardinality(p_class_names) = 0 or cardinality(p_class_names) > 30 then
    raise exception 'Add between 1 and 30 classes.';
  end if;
  if exists (
    select 1 from unnest(p_class_names) as requested(class_name)
    where requested.class_name is null or length(btrim(requested.class_name)) not between 1 and 100
  ) then
    raise exception 'Each class name must contain 1 to 100 characters.';
  end if;
  select count(*) into v_duplicate_count
  from (
    select lower(btrim(requested.class_name))
    from unnest(p_class_names) as requested(class_name)
    group by lower(btrim(requested.class_name))
    having count(*) > 1
  ) duplicates;
  if v_duplicate_count > 0 then raise exception 'Class names must be unique.'; end if;
  if exists (select 1 from public.teacher_streams s where s.owner_user_id = v_user_id) then
    raise exception 'Your account already has a teaching space.';
  end if;

  insert into public.teacher_streams (owner_user_id, name)
  values (v_user_id, btrim(p_name))
  returning id into v_stream_id;
  foreach v_class_name in array p_class_names loop
    insert into public.classrooms (stream_id, name)
    values (v_stream_id, btrim(v_class_name));
  end loop;
  return v_stream_id;
end;
$$;

-- Accept spaces and hyphens for readability without silently discarding other characters.
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
  where i.code = v_code and i.expires_at > clock_timestamp();
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

-- Save a teacher's chapter, assigned classes, questions, and answer keys atomically.
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
      raise exception 'Published chapters are read-only. Create a new chapter to make changes.';
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

  return v_chapter_id;
end;
$$;

create or replace function public.save_chapter(
  p_stream_id uuid,
  p_chapter_id uuid,
  p_title text,
  p_subject text,
  p_class_ids uuid[],
  p_questions jsonb,
  p_publish boolean
)
returns uuid language sql security invoker set search_path = ''
as $$
  select private.save_chapter(p_stream_id, p_chapter_id, p_title, p_subject, p_class_ids, p_questions, p_publish);
$$;

create or replace function public.create_teacher_space(p_name text, p_class_names text[])
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_teacher_space(p_name, p_class_names); $$;

revoke all on function private.save_chapter(uuid, uuid, text, text, uuid[], jsonb, boolean) from public, anon;
grant execute on function private.save_chapter(uuid, uuid, text, text, uuid[], jsonb, boolean) to authenticated;
revoke all on function private.create_teacher_space(text, text[]) from public, anon;
grant execute on function private.create_teacher_space(text, text[]) to authenticated;
revoke all on function public.create_teacher_space(text, text[]) from public, anon;
grant execute on function public.create_teacher_space(text, text[]) to authenticated;
revoke all on function public.save_chapter(uuid, uuid, text, text, uuid[], jsonb, boolean) from public, anon;
grant execute on function public.save_chapter(uuid, uuid, text, text, uuid[], jsonb, boolean) to authenticated;
