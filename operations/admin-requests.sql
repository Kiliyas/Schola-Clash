-- Run as a trusted database administrator. Never expose these statements to clients.
-- Pending requests; inspect IDs without exporting student notes to public logs.
select r.id, r.kind, r.created_at, p.display_name
from public.account_requests r join public.user_profiles p on p.id=r.user_id
where r.status='pending' order by r.created_at;

-- Teacher approval template. Replace only the request UUID after checking school identity.
-- begin;
-- select * from public.account_requests where id='REQUEST_UUID'::uuid for update;
-- update public.user_profiles p set role='teacher' from public.account_requests r
-- where r.id='REQUEST_UUID'::uuid and r.user_id=p.id and r.kind='teacher_access' and r.status='pending';
-- update public.account_requests set status='approved', resolved_at=clock_timestamp()
-- where id='REQUEST_UUID'::uuid and kind='teacher_access' and status='pending';
-- commit;

-- Deletion is deliberately a separate administrator procedure:
-- 1. Verify identity and the school's record-retention decision.
-- 2. Revoke sessions and ban the account through Supabase Auth Admin.
-- 3. Export records only if required; anonymize retained history or delete it according to policy.
-- 4. Delete the Auth user after restrictive match/stream references have been handled.
-- 5. Mark the request completed only after verifying removal/anonymization.
-- Never mark a request completed merely because it was received.

-- Daily retention, after deploying the migration:
select private.purge_operational_data();
