-- Cover the creator foreign key for invite cleanup and teacher-side lookups.
create index class_invites_created_by_idx on public.class_invites (created_by);
