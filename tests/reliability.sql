-- All synthetic records and retention changes are rolled back.
begin;
create temporary table reliability_ids(teacher uuid, other_teacher uuid, one uuid, two uuid, three uuid, outsider uuid, stream uuid, class uuid, chapter uuid, attempt uuid);
insert into reliability_ids values(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), null,null,null,gen_random_uuid());
grant select on reliability_ids to authenticated, anon;
do $$
declare
  t reliability_ids%rowtype; v_questions jsonb; v_answers jsonb; v_copy uuid; v_foreign_stream uuid;
  v_foreign_class uuid; v_challenge uuid; v_match uuid; v_result jsonb; v_rejected boolean; v_n integer; v_version timestamptz;
begin
  select * into t from reliability_ids;
  insert into auth.users(id,raw_user_meta_data,raw_app_meta_data)
  select value, '{"display_name":"Reliability rollback test"}', '{}' from unnest(array[t.teacher,t.other_teacher,t.one,t.two,t.three,t.outsider]) value;
  update public.user_profiles set role='teacher' where id in(t.teacher,t.other_teacher);
  perform set_config('request.jwt.claim.sub',t.teacher::text,true);
  t.stream := public.create_teacher_space('Reliability rollback',array['Active class']);
  select id into t.class from public.classrooms where stream_id=t.stream;
  insert into public.class_members(class_id,user_id) values(t.class,t.one),(t.class,t.two),(t.class,t.three);
  select jsonb_agg(jsonb_build_object('prompt','Question '||n,'options',jsonb_build_array('A','B','C','D'),'correct_option_index',0,'explanation','Explanation') order by n) into v_questions from generate_series(1,15) n;
  t.chapter := public.save_chapter(t.stream,null,'Reliability chapter','Science',array[t.class],v_questions,true);
  update reliability_ids set stream=t.stream, class=t.class, chapter=t.chapter;
  select updated_at into v_version from public.chapters where id=t.chapter;
  perform public.save_chapter_versioned(t.stream,t.chapter,'Versioned chapter','Science',array[t.class],v_questions,true,v_version);
  v_rejected:=false;
  begin
    perform public.save_chapter_versioned(t.stream,t.chapter,'Stale overwritten chapter','Science',array[t.class],v_questions,true,v_version);
  exception when sqlstate 'SC001' then v_rejected:=true;
  end;
  if not v_rejected or (select title from public.chapters where id=t.chapter)<>'Versioned chapter' then raise exception 'Stale editor overwrote a newer chapter.'; end if;
  v_copy := public.manage_chapter(t.chapter,'copy');
  if (select published_at from public.chapters where id=v_copy) is not null or (select count(*) from public.chapter_questions where chapter_id=v_copy)<>15 then raise exception 'Copy must be a complete draft.'; end if;
  perform public.manage_chapter(t.chapter,'unpublish');
  if private.student_has_chapter(t.one,t.chapter) then raise exception 'Unpublished chapter leaked.'; end if;
  perform public.save_chapter(t.stream,t.chapter,'Reliability chapter','Science',array[t.class],v_questions,true);
  perform public.manage_chapter(t.chapter,'archive');
  if private.student_has_chapter(t.one,t.chapter) then raise exception 'Archived chapter leaked.'; end if;
  perform public.manage_chapter(t.chapter,'restore');
  perform public.manage_class(t.class,'rename','Renamed class');
  if (select name from public.classrooms where id=t.class)<>'Renamed class' then raise exception 'Rename failed.'; end if;
  perform public.manage_class(t.class,'archive');
  if private.student_has_chapter(t.one,t.chapter) then raise exception 'Archived class leaked.'; end if;
  v_rejected:=false;
  begin perform public.create_class_invite(t.class); exception when others then v_rejected:=true; end;
  if not v_rejected then raise exception 'Archived class allowed invitations.'; end if;
  perform public.manage_class(t.class,'restore');
  perform set_config('request.jwt.claim.sub',t.other_teacher::text,true);
  v_foreign_stream := public.create_teacher_space('Other teacher',array['Other class']);
  select id into v_foreign_class from public.classrooms where stream_id=v_foreign_stream;
  insert into public.class_members(class_id,user_id) values(v_foreign_class,t.outsider);
  v_rejected:=false;
  begin perform public.manage_chapter(t.chapter,'archive'); exception when others then v_rejected:=true; end;
  if not v_rejected then raise exception 'Other teacher modified chapter.'; end if;
  perform set_config('request.jwt.claim.sub',t.one::text,true);
  select jsonb_agg(jsonb_build_object('question_id',id,'answer',case when position=1 then 1 else 0 end) order by position) into v_answers from public.chapter_questions where chapter_id=t.chapter;
  v_result := public.submit_practice(t.chapter,v_answers,t.attempt);
  perform public.submit_practice(t.chapter,v_answers,t.attempt);
  if v_result->>'correct_count'<>'14' or (select count(*) from public.practice_attempts where id=t.attempt)<>1 then raise exception 'Practice scoring/idempotency failed.'; end if;
  if jsonb_array_length(public.get_missed_practice_questions(t.chapter))<>1 then raise exception 'Missed-question review is wrong.'; end if;
  select jsonb_agg(jsonb_build_object('question_id',id,'answer',0)) into v_answers from public.chapter_questions where chapter_id=t.chapter and position=1;
  perform public.submit_practice_round(t.chapter,v_answers,gen_random_uuid(),true);
  if (select latest_accuracy from public.get_learning_progress_by_mode() where chapter_id=t.chapter and not is_review)<>93
    or (select latest_accuracy from public.get_learning_progress_by_mode() where chapter_id=t.chapter and is_review)<>100 then
    raise exception 'Mistake review overwrote full practice accuracy.';
  end if;
  perform public.request_account_action('teacher_access','Test school');
  perform public.request_account_action('teacher_access','Updated school');
  if (select count(*) from public.account_requests where user_id=t.one and status='pending')<>1 then raise exception 'Duplicate access requests.'; end if;
  if private.is_teacher_profile(t.one) then raise exception 'Request elevated role.'; end if;
  perform public.report_client_error('account','client_error');
  perform public.report_client_error('account','token=secret');
  if (select count(*) from private.client_errors where user_id=t.one)<>1 then raise exception 'Diagnostics accepted sensitive text.'; end if;
  -- Three accepted matches for student two, with mixed first/second player positions.
  for v_n in 1..3 loop
    v_challenge := gen_random_uuid();
    insert into public.challenges(id,chapter_id,challenger_id,opponent_id,status)
    values(v_challenge,t.chapter,case when v_n=1 then t.one else t.three end,t.two,'accepted');
    insert into public.matches(challenge_id,chapter_id,stream_id,player_one_id,player_two_id,status)
    values(v_challenge,t.chapter,t.stream,case when v_n=1 then t.one when v_n=2 then t.two else t.three end,
      case when v_n=2 then t.three else t.two end,'no_contest');
  end loop;
  v_rejected:=false;
  begin perform public.create_challenge(t.chapter,t.two); exception when others then v_rejected:=true; end;
  if not v_rejected then raise exception 'Fourth match invitation was allowed for second player.'; end if;
  -- Invitations created before a concurrent limit change must be checked again on acceptance.
  insert into public.challenges(chapter_id,challenger_id,opponent_id) values(t.chapter,t.one,t.two) returning id into v_challenge;
  perform set_config('request.jwt.claim.sub',t.two::text,true);
  v_result:=public.accept_challenge(v_challenge);
  if v_result->>'status'<>'match_limit_reached' then raise exception 'Acceptance bypassed the three-match limit.'; end if;
end;
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub',(select outsider::text from reliability_ids),true);
do $$
declare t reliability_ids%rowtype; v_rejected boolean;
begin
  select * into t from reliability_ids;
  if exists(select 1 from public.chapter_questions where chapter_id=t.chapter) or exists(select 1 from public.chapters where id=t.chapter) then raise exception 'Cross-class RLS leak.'; end if;
  if exists(select 1 from public.practice_attempts where user_id=t.one) then raise exception 'Practice progress leaked to a classmate.'; end if;
  v_rejected:=false;
  begin perform public.get_practice_questions(t.chapter); exception when others then v_rejected:=true; end;
  if not v_rejected then raise exception 'Practice RPC leaked another class.'; end if;
  v_rejected:=false;
  begin update public.user_profiles set role='teacher' where id=t.outsider; exception when insufficient_privilege then v_rejected:=true; end;
  if not v_rejected then raise exception 'Students can change their role.'; end if;
  v_rejected:=false;
  begin perform public.manage_class(t.class,'rename','Stolen'); exception when others then v_rejected:=true; end;
  if not v_rejected then raise exception 'Student modified a class.'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub',(select teacher::text from reliability_ids),true);
set local role authenticated;
do $$
declare t reliability_ids%rowtype;
begin
  select * into t from reliability_ids;
  if not exists(select 1 from public.get_learning_progress_by_mode(t.stream) where user_id=t.one and not is_review and latest_accuracy=93) then raise exception 'Teacher practice progress missing.'; end if;
end;
$$;
reset role;
set local role anon;
do $$
declare v_rejected boolean := false;
begin
  begin perform public.get_learning_progress(); exception when insufficient_privilege then v_rejected:=true; end;
  if not v_rejected then raise exception 'Anonymous role can read learning progress.'; end if;
end;
$$;
reset role;
rollback;
