# Schola Clash

An online classroom review app. Teachers prepare chapters and review student progress; students practise and challenge classmates.

## Run

Run a local web server from this folder and open `http://localhost:8000`:

```powershell
python -m http.server 8000
```

There is no build step. The app loads Supabase JS from a CDN and uses the project configured in `supabase/client-config.js`. An internet connection and an account are required. Signing out returns to the sign-in form.

See [supabase/README.md](supabase/README.md) for database setup, access rules, and teacher role assignment.

See [инструкция по публикации](operations/HOSTING.md) for GitHub Pages, required database migrations, SMTP and Auth redirects. Website publication is manual and disabled until configured.

## Account flow

1. Sign in with an existing account or create an account. Confirm your email if required.
2. New accounts are students. A trusted project administrator assigns teacher access.
3. Teachers create a teaching space and classes, then share class join codes.
4. Students join classes with those codes and open assigned chapters.
5. Students challenge a classmate, submit independently, and return to see both scores and answer explanations.

## Features

- Teacher and student dashboards with responsive layouts.
- Chapter creation, draft saving, editing, and publishing with at least 15 questions.
- Inline question editing, local draft autosave and restoration, and unsaved-change warnings.
- Chapter/class archiving and restoration, chapter copying/unpublishing, and class renaming.
- Server-scored practice progress and practice of missed questions, separate from ELO.
- Teacher-access and deletion requests with status and cancellation, plus confirmation-email resend.
- Student profiles for teachers, including ELO, class membership, chapter progress, and recent matches.
- Prominent student ELO, with separate ratings for each teacher's teaching space.
- Full-chapter practice with shuffled choices and answer review, without rating changes.
- Up to three accepted ranked matches per chapter, with separate answer-choice ordering for each player.
- Invitations expire after three hours. New ranked matches share a non-pausing server deadline starting on acceptance: one minute per sampled question, with a five-minute minimum. Both players must be ready before the invitation is accepted. Existing matches keep the deadline they were originally given.
- Forfeits and no-contests preserve match history and do not change ELO.
- Teachers can remove class members without deleting accounts or match history.
- Server-side validation and row-level access checks.
- Ranked answers are temporarily saved on this device, separately for each account and match. Reopen the match after refreshing or closing a tab to continue. Saved choices are discarded after successful submission or sign-out, and expired drafts are removed when a match is next opened. They are not synced across devices; clearing browser storage removes them.
- Submission controls prevent double clicks. A failed request keeps the quiz open so the student can retry. If browser storage is unavailable, the quiz still works but cannot restore unsent choices after a reload.

## Not implemented

Photo or document upload, OCR, question generation, and real-time matches are not available. Speed does not affect ranked scores.

## Browser checks

With the local server running, Playwright available to Node, and Chrome installed, run:

```powershell
node tests/profiles.browser.cjs
node tests/workflow.browser.cjs
```

The checks use isolated online-account fixtures and block external requests and database writes. They cover sign-in, registration, sign-out, account restoration, student profiles, ELO, practice, consumer-facing error messages, and desktop/mobile layouts. Legacy local workspace data is seeded to verify it is ignored.

Screenshots are saved to `schola-profile-smoke` in the system temporary directory. Set `SCHOLA_TEST_URL` to use another local port or `SCHOLA_BROWSER_CHANNEL` to select another installed Chromium browser.

The workflow suite uses a shared, stateful transport fixture with separate teacher and student browser contexts. On desktop and two mobile widths, it covers publishing 15 questions, challenging and accepting, answering with per-player choice order, restoring answers after reload, retrying a network/server failure, blocking duplicate submission, recovering after a lost acknowledgement, displaying both scores/ELO, and teacher progress. It also covers invalid/expired drafts, account isolation, unavailable storage, sign-out during submission, and expired-match display. Screenshots are saved to `schola-workflow-smoke` in the system temporary directory.

These browser suites validate workflows, not deployed Postgres scoring, RLS, or concurrency guarantees. They never send test writes to the connected Supabase project. The workflow suite also exercises countdown expiry and a device clock set years ahead; the quiz anchors its remaining time to the server response and a monotonic browser clock.

`tests/timed-matches.sql` is an administrator-only database integration check. It creates synthetic users without credentials and a classroom inside a transaction, exercises the real RPCs, and rolls everything back. It verifies duration, unchanged deadlines after reopening/repeated acceptance, server-time responses, rejection of late answers, forfeit/no-contest behavior, on-time scoring/ELO, and no duplicate rating application. Run the entire file, including `rollback`, in a trusted SQL session after all migrations. Separate reliability and concurrent-session suites cover cross-class RLS and simultaneous requests.

## Account management

Use **Forgot password?** on the sign-in screen to request a recovery email, then follow its link and enter the new password twice. **My account** lets signed-in users change their display name. Teacher roles are still assigned by a trusted school administrator.

In Supabase Auth URL Configuration, set the production Site URL and allow the exact app URL used for recovery (including the path and local development URL when needed). Configure email delivery before testing real recovery emails. Recovery redirects to the app's current origin and pathname.

Browser checks use isolated Supabase fixtures and do not send real emails:

```powershell
node tests/account.browser.cjs
$env:SCHOLA_TEST_OFFLINE = "1"
node tests/profiles.browser.cjs
node tests/workflow.browser.cjs
```

The offline option serves workspace files directly to Chrome without a local HTTP server.

## Reliability release — deployment pending

The new account/material/practice operations require `supabase/migrations/20261009070651_account_learning_reliability.sql`, followed by `20261009163852_chapter_versioned_saves.sql`. Both are locally validated but **not applied to the live project**. Deploy the database migrations before the updated frontend. The editor checks chapter versions and uses the chapter's own teaching space; full practice and mistake reviews have separate progress rows. See [deployment and rollback instructions](operations/DEPLOYMENT.md) for the exact release, backup, SMTP and test-project requirements.

Development dependencies are pinned in `package.json` and `pnpm-lock.yaml`. After `pnpm install --frozen-lockfile`, run:

```powershell
$env:SCHOLA_TEST_OFFLINE = "1"
pnpm test:database
pnpm test:profiles
pnpm test:account
pnpm test:workflow
pnpm test:reliability
python tests/backup.test.py
```

`test:database` uses an isolated PostgreSQL engine and verifies transactional behavior and a restored snapshot. `test:integration` requires a private `SCHOLA_TEST_DATABASE_URL` for a disposable PostgreSQL/Supabase test database; it checks real simultaneous sessions and cleans up synthetic data. It refuses the live project's connection. This suite passed locally on native PostgreSQL 17.10, including simultaneous acceptance, submission and the three-match boundary. CI prepares an empty PostgreSQL service with `test:bootstrap`. Hosted Supabase integration is still required before deployment; browser fixtures and the single-backend engine alone do not establish concurrency guarantees.

Daily encrypted backups and retention are prepared in `.github/workflows/operations.yml`, disabled until the required private secrets and repository variable are configured. Real production backup/restore and email delivery remain unverified. The supplied email had no registered test account; successful mail API responses did not establish delivery.
