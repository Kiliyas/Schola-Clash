-- Shareable classroom join codes. Codes can only be created by the owning teacher;
-- students join through a narrowly scoped RPC rather than direct membership writes.

create table public.class_invites (
  code text primary key check (code ~ '^[A-F0-9]{12}$'),
  class_id uuid not null references public.classrooms (id) on delete cascade,
  created_by uuid not null references public.user_profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index class_invites_class_id_idx on public.class_invites (class_id);
alter table public.class_invites enable row level security;

create policy class_invites_read_owner on public.class_invites
for select to authenticated using (private.can_manage_class(class_id));

revoke all on public.class_invites from anon, authenticated;
grant select on public.class_invites to authenticated;

create or replace function private.create_class_invite(p_class_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_code text;
  v_attempt integer;
begin
  if v_user_id is null then raise exception 'Sign in before creating a class invitation.'; end if;
  if not private.can_manage_class(p_class_id) then
    raise exception 'Only the owning teacher can create an invitation for this class.';
  end if;

  for v_attempt in 1..5 loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    insert into public.class_invites (code, class_id, created_by)
    values (v_code, p_class_id, v_user_id)
    on conflict (code) do nothing;
    if found then return v_code; end if;
  end loop;

  raise exception 'Could not create a unique class invitation. Please try again.';
end;
$$;

create or replace function private.join_class_by_code(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Fa-f0-9]', '', 'g'));
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

create or replace function public.create_class_invite(p_class_id uuid)
returns text language sql security invoker set search_path = ''
as $$ select private.create_class_invite(p_class_id); $$;

create or replace function public.join_class_by_code(p_code text)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.join_class_by_code(p_code); $$;

revoke all on function private.create_class_invite(uuid), private.join_class_by_code(text) from public, anon;
grant execute on function private.create_class_invite(uuid), private.join_class_by_code(text) to authenticated;
revoke all on function public.create_class_invite(uuid), public.join_class_by_code(text) from public, anon;
grant execute on function public.create_class_invite(uuid), public.join_class_by_code(text) to authenticated;
