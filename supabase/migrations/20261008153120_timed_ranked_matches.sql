-- Only new matches get the short timer; existing matches retain their agreed deadline.
create or replace function private.ranked_match_duration(p_question_count integer)
returns interval language sql immutable security invoker set search_path = ''
as $$ select make_interval(mins => greatest(5, p_question_count)); $$;
revoke all on function private.ranked_match_duration(integer) from public, anon, authenticated;

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
revoke all on function private.accept_challenge(uuid) from public, anon;
grant execute on function private.accept_challenge(uuid) to authenticated;

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
    'scores', v_scores, 'server_now', clock_timestamp()
  );
end;
$$;
revoke all on function private.refresh_match(uuid) from public, anon;
grant execute on function private.refresh_match(uuid) to authenticated;
