# Supabase backend foundation

`backend.sql` contains the initial schema. The tracked deployment history is in `migrations/`; it contains the initial schema, foreign-key indexes and policies, class invitation codes, and atomic teacher-space/chapter RPCs. These migrations are applied to the connected development project **Schola clash** (`bqhzqsyfzbwprhummugp`).

## What it covers

- Auth-backed teacher and student profiles, teacher streams, classes, and class membership.
- Draft and published chapters, with a minimum of 15 questions and one answer key per question before publishing.
- Row-level security for profiles, classes, chapters, matches, attempts, and ratings.
- Challenge creation, cancellation, and acceptance. Accepting a challenge creates a match and consumes one of the chapter's three ranked matches.
- Teacher-owned class join codes; students join through a narrowly scoped RPC.
- Atomic teaching-space creation and chapter draft/publication saves. Publishing checks question completeness and the 15-question minimum on the server.
- Random shared question samples, separate saved option orders for each student, server-enforced short shared deadlines, server-side scoring, and stream ELO updates.

New ranked matches start their shared timer when accepted: one minute per sampled question, with a five-minute minimum. The acceptance RPC creates the deadline once; refresh and repeated acceptance never extend it. Existing matches retain their previous deadlines. `refresh_match` includes `server_now` so the browser countdown is independent of the device's wall clock. Submission still resolves expiry under a row lock and rejects late answers before writing an attempt. Practice has no timer.
- Answer keys stay unreadable to students until both students submit. Match questions and keys are snapshotted so later chapter edits cannot change an existing match.

The client RPCs are `create_teacher_space`, `create_class_invite`, `join_class_by_code`, `save_chapter`, `create_challenge`, `cancel_challenge`, `accept_challenge`, `submit_match_answers`, and `refresh_match`. Calls must come from an authenticated Supabase session. Read queries use the public tables and their RLS policies.

The browser client provides email/password sign-in, student account creation, and a profile read from `public.user_profiles`. Only authenticated users can open teacher or student workspaces. Signing out returns to the sign-in screen. New accounts start as students. Teacher roles must be assigned by a trusted project administrator; never add a public role selector.

## Security setup

- Keep the `private` schema out of Supabase's Data API exposed schemas. The public RPC wrappers are invoker-rights functions; their private implementations check `auth.uid()` and have an empty `search_path`.
- The frontend reads `public.user_profiles` through the Data API. Keep `public` exposed and `private` unexposed; schema exposure alone is not authorization, so retain explicit table grants and RLS policies.
- The signup trigger assigns `student` by default. A trusted administrator assigns teacher access by changing `public.user_profiles.role`; authenticated users receive permission to update only `display_name`. Do not expose a public role selector.
- Only authenticated users receive table access. RLS limits each row to the student's classes or the owning teacher's stream. Server-side RPCs validate the role and ownership again before writes.
- Never put a service-role or secret key in this static frontend.

## Assign teacher access

Run this from the Supabase Dashboard **SQL Editor** as a trusted project administrator, replacing the address with the teacher's sign-in email. Then sign out and back in so the browser reloads the profile role.

```sql
update public.user_profiles as profile
set role = 'teacher'
from auth.users as account
where account.id = profile.id
  and lower(account.email) = lower('teacher@example.com');
```

Do not grant authenticated users permission to change their own `role`.

## Current setup status

Supabase is connected to this Codex session, and the static app loads a browser client configured with the project's URL and publishable key. Email/password sign-in, student sign-up, profile reads, and the live classroom flow are wired in the client. At least one user profile exists in the project. The Supabase CLI is not installed here, so migration files use the exact versions returned by the connected project. Check the Supabase security advisor before a school pilot; leaked-password protection may need to be enabled in Auth settings.

Do not reapply these migrations manually. Use new versioned migrations for later schema changes.
