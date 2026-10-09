-- Administrator-only integration check. All synthetic data is rolled back.
begin;
do $$
declare
  v_teacher uuid := gen_random_uuid();
  v_one uuid := gen_random_uuid();
  v_two uuid := gen_random_uuid();
  v_stream uuid;
  v_class uuid;
  v_chapter uuid;
  v_challenge uuid;
  v_match uuid;
  v_result jsonb;
  v_questions jsonb;
  v_answers jsonb;
  v_started timestamptz;
  v_deadline timestamptz;
begin
  if private.ranked_match_duration(5) <> interval '5 minutes'
    or private.ranked_match_duration(10) <> interval '10 minutes'
    or private.ranked_match_duration(33) <> interval '33 minutes' then
    raise exception 'Duration must be one minute per question.';
  end if;
  insert into auth.users (id, raw_user_meta_data, raw_app_meta_data)
  values (v_teacher, '{"display_name":"Timer integration teacher"}', '{}'),
         (v_one, '{"display_name":"Timer integration student 1"}', '{}'),
         (v_two, '{"display_name":"Timer integration student 2"}', '{}');
  update public.user_profiles set role = 'teacher' where id = v_teacher;
  perform set_config('request.jwt.claim.sub', v_teacher::text, true);
  v_stream := public.create_teacher_space('Timer integration rollback', array['Timer integration class']);
  select id into v_class from public.classrooms where stream_id = v_stream;
  insert into public.class_members (class_id, user_id) values (v_class, v_one), (v_class, v_two);
  select jsonb_agg(jsonb_build_object('prompt', 'Question ' || n, 'options', jsonb_build_array('A', 'B', 'C', 'D'), 'correct_option_index', 0, 'explanation', 'Test explanation') order by n)
  into v_questions from generate_series(1, 15) as questions(n);
  v_chapter := public.save_chapter(v_stream, null, 'Timed chapter', 'Test', array[v_class], v_questions, true);

  perform set_config('request.jwt.claim.sub', v_one::text, true);
  v_challenge := public.create_challenge(v_chapter, v_two);
  perform set_config('request.jwt.claim.sub', v_two::text, true);
  v_result := public.accept_challenge(v_challenge);
  v_match := (v_result ->> 'match_id')::uuid;
  select started_at, deadline_at into v_started, v_deadline from public.matches where id = v_match;
  if v_result ->> 'status' <> 'active' or v_deadline - v_started <> interval '5 minutes' then
    raise exception 'Acceptance must start a five-minute shared timer.';
  end if;
  perform public.accept_challenge(v_challenge);
  perform public.refresh_match(v_match);
  if (select deadline_at from public.matches where id = v_match) <> v_deadline then
    raise exception 'Accepting twice or reopening must not reset the timer.';
  end if;
  if public.refresh_match(v_match) ->> 'server_now' is null then
    raise exception 'Match refresh must expose the authoritative server time.';
  end if;
  update public.matches set deadline_at = clock_timestamp() - interval '1 millisecond' where id = v_match;
  v_result := public.submit_match_answers(v_match, '[0,0,0,0,0]');
  if v_result ->> 'status' <> 'no_contest' or exists (select 1 from public.match_attempts where match_id = v_match and submitted_at is not null) then
    raise exception 'An expired match must reject answers without saving them.';
  end if;

  perform set_config('request.jwt.claim.sub', v_one::text, true);
  v_challenge := public.create_challenge(v_chapter, v_two);
  perform set_config('request.jwt.claim.sub', v_two::text, true);
  v_result := public.accept_challenge(v_challenge);
  v_match := (v_result ->> 'match_id')::uuid;
  perform set_config('request.jwt.claim.sub', v_one::text, true);
  perform public.submit_match_answers(v_match, '[0,0,0,0,0]');
  update public.matches set deadline_at = clock_timestamp() - interval '1 millisecond' where id = v_match;
  perform set_config('request.jwt.claim.sub', v_two::text, true);
  v_result := public.submit_match_answers(v_match, '[0,0,0,0,0]');
  if v_result ->> 'status' <> 'forfeit' or (v_result ->> 'winner_id')::uuid <> v_one
    or exists (select 1 from public.match_attempts where match_id = v_match and user_id = v_two and submitted_at is not null)
    or exists (select 1 from public.stream_ratings where stream_id = v_stream and rating <> 1000) then
    raise exception 'Late opponent must forfeit without changing ELO or saving late answers.';
  end if;

  perform set_config('request.jwt.claim.sub', v_one::text, true);
  v_challenge := public.create_challenge(v_chapter, v_two);
  perform set_config('request.jwt.claim.sub', v_two::text, true);
  v_result := public.accept_challenge(v_challenge);
  v_match := (v_result ->> 'match_id')::uuid;
  select jsonb_agg((choice.ordinality - 1)::integer order by q.position) into v_answers
  from public.match_player_questions pq join public.match_questions q on q.id = pq.match_question_id
  cross join lateral jsonb_array_elements(pq.display_order) with ordinality as choice(value, ordinality)
  where pq.match_id = v_match and pq.user_id = v_one and choice.value = '0'::jsonb;
  perform set_config('request.jwt.claim.sub', v_one::text, true);
  perform public.submit_match_answers(v_match, v_answers);
  select jsonb_agg((choice.ordinality % 4)::integer order by q.position) into v_answers
  from public.match_player_questions pq join public.match_questions q on q.id = pq.match_question_id
  cross join lateral jsonb_array_elements(pq.display_order) with ordinality as choice(value, ordinality)
  where pq.match_id = v_match and pq.user_id = v_two and choice.value = '0'::jsonb;
  perform set_config('request.jwt.claim.sub', v_two::text, true);
  v_result := public.submit_match_answers(v_match, v_answers);
  if v_result ->> 'status' <> 'completed'
    or (v_result -> 'scores' ->> v_one::text)::integer <> 5
    or (v_result -> 'scores' ->> v_two::text)::integer <> 0
    or (select rating from public.stream_ratings where stream_id = v_stream and user_id = v_one) <> 1016
    or (select rating from public.stream_ratings where stream_id = v_stream and user_id = v_two) <> 984 then
    raise exception 'On-time answers must still score correctly and update ELO once.';
  end if;
  perform public.submit_match_answers(v_match, v_answers);
  if (select rating from public.stream_ratings where stream_id = v_stream and user_id = v_one) <> 1016 then
    raise exception 'Repeated completed submission must not apply ELO twice.';
  end if;
end;
$$;
rollback;
