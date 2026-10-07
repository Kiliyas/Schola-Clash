-- Add covering indexes for frequent foreign-key lookups.
create index challenges_chapter_id_idx on public.challenges (chapter_id);
create index challenges_opponent_id_idx on public.challenges (opponent_id);
create index match_player_questions_question_id_idx on public.match_player_questions (match_question_id);
create index match_player_questions_user_id_idx on public.match_player_questions (user_id);
create index match_questions_source_question_id_idx on public.match_questions (source_question_id);
create index matches_forfeit_by_idx on public.matches (forfeit_by);
create index matches_player_one_id_idx on public.matches (player_one_id);
create index matches_player_two_id_idx on public.matches (player_two_id);
create index matches_stream_id_idx on public.matches (stream_id);
create index matches_winner_id_idx on public.matches (winner_id);
create index teacher_streams_owner_user_id_idx on public.teacher_streams (owner_user_id);

-- Keep one SELECT policy per table/action. Write access remains teacher-only.
drop policy chapter_classes_manage_teacher on public.chapter_classes;
create policy chapter_classes_insert_teacher on public.chapter_classes
for insert to authenticated with check (
  exists (
    select 1 from public.chapters ch
    where ch.id = chapter_id and private.can_manage_stream(ch.stream_id)
  )
);
create policy chapter_classes_delete_teacher on public.chapter_classes
for delete to authenticated using (
  exists (
    select 1 from public.chapters ch
    where ch.id = chapter_id and private.can_manage_stream(ch.stream_id)
  )
);

drop policy chapter_questions_manage_teacher on public.chapter_questions;
create policy chapter_questions_insert_teacher on public.chapter_questions
for insert to authenticated with check (
  exists (
    select 1 from public.chapters ch
    where ch.id = chapter_id and private.can_manage_stream(ch.stream_id)
  )
);
create policy chapter_questions_update_teacher on public.chapter_questions
for update to authenticated using (
  exists (
    select 1 from public.chapters ch
    where ch.id = chapter_id and private.can_manage_stream(ch.stream_id)
  )
) with check (
  exists (
    select 1 from public.chapters ch
    where ch.id = chapter_id and private.can_manage_stream(ch.stream_id)
  )
);
create policy chapter_questions_delete_teacher on public.chapter_questions
for delete to authenticated using (
  exists (
    select 1 from public.chapters ch
    where ch.id = chapter_id and private.can_manage_stream(ch.stream_id)
  )
);
