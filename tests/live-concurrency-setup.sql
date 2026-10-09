-- Temporary committed fixture for concurrent sessions. Always run matching cleanup.
begin;
do $$
declare
  v_run uuid := gen_random_uuid(); v_teacher uuid := gen_random_uuid();
  v_one uuid := gen_random_uuid(); v_two uuid := gen_random_uuid(); v_three uuid := gen_random_uuid(); v_four uuid := gen_random_uuid();
  v_stream uuid; v_class uuid; v_chapter uuid; v_challenge uuid; v_questions jsonb;
begin
  insert into auth.users(id,raw_user_meta_data,raw_app_meta_data)
  select id, jsonb_build_object('display_name','Concurrency synthetic test','schola_test_run',v_run::text), '{}'::jsonb from unnest(array[v_teacher,v_one,v_two,v_three,v_four]) id;
  update public.user_profiles set role='teacher' where id=v_teacher;
  perform set_config('request.jwt.claim.sub',v_teacher::text,true);
  v_stream:=public.create_teacher_space('Concurrency synthetic test',array['Synthetic classroom']);
  select id into v_class from public.classrooms where stream_id=v_stream;
  insert into public.class_members(class_id,user_id) values(v_class,v_one),(v_class,v_two),(v_class,v_three),(v_class,v_four);
  select jsonb_agg(jsonb_build_object('prompt','Synthetic question '||n,'options',jsonb_build_array('A','B','C','D'),'correct_option_index',0,'explanation','Synthetic answer') order by n) into v_questions from generate_series(1,15) n;
  v_chapter:=public.save_chapter(v_stream,null,'Concurrency synthetic test','Test',array[v_class],v_questions,true);
  perform set_config('request.jwt.claim.sub',v_one::text,true);
  v_challenge:=public.create_challenge(v_chapter,v_two);
  perform set_config('schola.test_run',v_run::text,false);
  perform set_config('schola.test_teacher',v_teacher::text,false);
  perform set_config('schola.test_one',v_one::text,false);
  perform set_config('schola.test_two',v_two::text,false);
  perform set_config('schola.test_three',v_three::text,false);
  perform set_config('schola.test_four',v_four::text,false);
  perform set_config('schola.test_stream',v_stream::text,false);
  perform set_config('schola.test_chapter',v_chapter::text,false);
  perform set_config('schola.test_challenge',v_challenge::text,false);
end;
$$;
commit;
select current_setting('schola.test_run') as run_id, current_setting('schola.test_teacher') as teacher,
  current_setting('schola.test_one') as one, current_setting('schola.test_two') as two,
  current_setting('schola.test_stream') as stream, current_setting('schola.test_chapter') as chapter,
  current_setting('schola.test_challenge') as challenge, current_setting('schola.test_three') as three, current_setting('schola.test_four') as four;
