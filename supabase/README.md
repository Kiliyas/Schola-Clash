# Supabase backend foundation

`backend.sql` contains the initial schema. The tracked deployment history is in `migrations/`; it contains the initial schema and a follow-up migration for foreign-key indexes and policies. Both migrations have been applied to the empty development project **Schola clash** (`bqhzqsyfzbwprhummugp`).

## What it covers

- Auth-backed teacher and student profiles, teacher streams, classes, and class membership.
- Draft and published chapters, with a minimum of 15 questions and one answer key per question before publishing.
- Row-level security for profiles, classes, chapters, matches, attempts, and ratings.
- Challenge creation, cancellation, and acceptance. Accepting a challenge creates a match and consumes one of the chapter's three ranked matches.
- Random shared question samples, separate saved option orders for each student, 24-hour deadlines, server-side scoring, and stream ELO updates.
- Answer keys stay unreadable to students until both students submit. Match questions and keys are snapshotted so later chapter edits cannot change an existing match.

The client RPCs are `create_challenge`, `cancel_challenge`, `accept_challenge`, `submit_match_answers`, and `refresh_match`. Calls must come from an authenticated Supabase session. Read queries use the public tables and their RLS policies.

The browser client now provides email/password sign-in, student account creation, and a profile read from `public.user_profiles`. A signed-in account gets a separate account screen; the local demo profile picker is hidden so a Supabase user is not mistaken for a demo persona. The demo dashboard still uses browser storage, and chapters/classes/matches have not yet been switched to database reads and writes. New accounts start as students. Teacher roles must be assigned by a trusted project administrator.

## Security setup

- Keep the `private` schema out of Supabase's Data API exposed schemas. The public RPC wrappers are invoker-rights functions; their private implementations check `auth.uid()` and have an empty `search_path`.
- The frontend reads `public.user_profiles` through the Data API. Keep `public` exposed and `private` unexposed; schema exposure alone is not authorization, so retain explicit table grants and RLS policies.
- The signup trigger assigns `student` by default. A teacher role must be set by a trusted administrator in `app_metadata`; do not use user-editable `user_metadata` for roles.
- Only authenticated users receive table access. RLS limits each row to the student's classes or the owning teacher's stream.
- Never put a service-role or secret key in this static frontend.

## Current setup status

Supabase is connected to this Codex session, and the static app loads a browser client configured with the project's URL and publishable key. The app supports email/password sign-in, student sign-up, and reading the signed-in user's profile. No application account has been created yet. The database security advisor reports no findings; the performance advisor reports only unused-index notices, expected before real traffic. The Supabase CLI is not installed here, so the local migration files were saved using the exact migration versions returned by the connected project. Dashboard chapters and matches still use browser `localStorage`; their database reads and writes are the next integration step.

Do not reapply these migrations manually. Use new versioned migrations for later schema changes.
