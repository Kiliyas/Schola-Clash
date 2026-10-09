-- Make the chapter version change on every write, including one transaction.
create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := clock_timestamp(); return new; end;
$$;

create function private.save_chapter_versioned(
  p_stream_id uuid, p_chapter_id uuid, p_title text, p_subject text,
  p_class_ids uuid[], p_questions jsonb, p_publish boolean, p_expected_updated_at timestamptz
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_chapter public.chapters%rowtype;
begin
  if (select auth.uid()) is null or not private.can_manage_stream(p_stream_id) then
    raise exception 'Only the chapter owner can save it.';
  end if;
  if p_chapter_id is not null then
    if not exists(select 1 from public.chapters where id=p_chapter_id and stream_id=p_stream_id) then
      raise exception 'This chapter does not belong to your teaching space.';
    end if;
    -- Acceptance locks an invitation before its chapter. Use the same order.
    perform 1 from public.challenges where chapter_id=p_chapter_id and status='pending' order by id for update;
    select * into v_chapter from public.chapters where id=p_chapter_id for update;
    if not found or v_chapter.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode='SC001', message='This chapter has changed in another window. Your edits are kept in this editor. Close it, refresh your workspace and reopen the chapter before saving.';
    end if;
  end if;
  return private.save_chapter(p_stream_id,p_chapter_id,p_title,p_subject,p_class_ids,p_questions,p_publish);
end;
$$;
create function public.save_chapter_versioned(
  p_stream_id uuid, p_chapter_id uuid, p_title text, p_subject text,
  p_class_ids uuid[], p_questions jsonb, p_publish boolean, p_expected_updated_at timestamptz
)
returns uuid language sql security invoker set search_path = '' as $$
  select private.save_chapter_versioned(p_stream_id,p_chapter_id,p_title,p_subject,p_class_ids,p_questions,p_publish,p_expected_updated_at);
$$;
revoke all on function private.save_chapter_versioned(uuid,uuid,text,text,uuid[],jsonb,boolean,timestamptz) from public,anon,authenticated;
revoke all on function public.save_chapter_versioned(uuid,uuid,text,text,uuid[],jsonb,boolean,timestamptz) from public,anon,authenticated;
grant execute on function private.save_chapter_versioned(uuid,uuid,text,text,uuid[],jsonb,boolean,timestamptz) to authenticated;
grant execute on function public.save_chapter_versioned(uuid,uuid,text,text,uuid[],jsonb,boolean,timestamptz) to authenticated;

alter table public.practice_attempts add column is_review boolean not null default false;
create function private.submit_practice_round(p_chapter_id uuid,p_answers jsonb,p_attempt_id uuid,p_review boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_existing public.practice_attempts%rowtype; v_result jsonb;
begin
  if (select auth.uid()) is null or p_review is null then raise exception 'Sign in and choose a practice mode.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('practice:' || p_attempt_id::text,0));
  select * into v_existing from public.practice_attempts where id=p_attempt_id;
  if found and (v_existing.user_id<>(select auth.uid()) or v_existing.chapter_id<>p_chapter_id or v_existing.is_review<>p_review) then
    raise exception 'Invalid practice attempt.';
  end if;
  v_result:=private.submit_practice(p_chapter_id,p_answers,p_attempt_id);
  update public.practice_attempts set is_review=p_review where id=p_attempt_id and user_id=(select auth.uid());
  return v_result;
end;
$$;
create function public.submit_practice_round(p_chapter_id uuid,p_answers jsonb,p_attempt_id uuid,p_review boolean)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.submit_practice_round(p_chapter_id,p_answers,p_attempt_id,p_review);
$$;
create function private.learning_progress_by_mode(p_stream_id uuid default null)
returns table(chapter_id uuid,user_id uuid,is_review boolean,attempt_count bigint,latest_accuracy integer,last_practiced_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  if p_stream_id is not null and not private.can_manage_stream(p_stream_id) then raise exception 'Only the teacher can view class practice progress.'; end if;
  return query select a.chapter_id,a.user_id,a.is_review,count(*),
    (array_agg(round(100.0*a.correct_count/a.question_count)::integer order by a.created_at desc,a.id desc))[1],max(a.created_at)
  from public.practice_attempts a join public.chapters ch on ch.id=a.chapter_id
  where (p_stream_id is null and a.user_id=(select auth.uid())) or (p_stream_id is not null and ch.stream_id=p_stream_id)
  group by a.chapter_id,a.user_id,a.is_review;
end;
$$;
create function public.get_learning_progress_by_mode(p_stream_id uuid default null)
returns table(chapter_id uuid,user_id uuid,is_review boolean,attempt_count bigint,latest_accuracy integer,last_practiced_at timestamptz)
language sql security invoker set search_path = '' as $$ select * from private.learning_progress_by_mode(p_stream_id); $$;
revoke all on function private.submit_practice_round(uuid,jsonb,uuid,boolean),public.submit_practice_round(uuid,jsonb,uuid,boolean),private.learning_progress_by_mode(uuid),public.get_learning_progress_by_mode(uuid) from public,anon,authenticated;
grant execute on function private.submit_practice_round(uuid,jsonb,uuid,boolean),public.submit_practice_round(uuid,jsonb,uuid,boolean),private.learning_progress_by_mode(uuid),public.get_learning_progress_by_mode(uuid) to authenticated;
