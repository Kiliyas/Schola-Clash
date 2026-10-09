# Account, learning and reliability release

The implementation is ready for review. It has **not** been deployed to the live database or website.

## What is included

- Teacher chapter drafts on the device, restoration after reopening, a close/reload warning, account isolation, seven-day expiry and sign-out cleanup.
- Archive/restore chapters and classes, unpublish, rename classes, and duplicate chapters as drafts. Existing match snapshots remain independent.
- Separate practice history with server-side correctness checks, idempotent retry, missed-question practice, student topic/chapter progress and teacher practice results. Completed matches also offer a local review of their missed questions.
- Confirmation-email resend, teacher-access requests and deletion requests with status/cancellation. Requests cannot grant a role or delete records themselves.
- Private, rate-limited error reporting with codes only; no passwords, raw error text, answers, emails, stack traces or URL tokens.
- Encrypted backup scripts, an isolated restore guard, daily maintenance workflow, a privacy page and CI checks.
- A per-player three-match limit fix and acceptance-time membership/archive checks.

## Verification performed

All eight tracked migrations were applied to an isolated PostgreSQL engine. `tests/timed-matches.sql` and `tests/reliability.sql` passed. Checks cover timers, single ELO application, mixed first/second-player match limits, ownership and cross-class RLS, anonymous denial, copy/archive/restore/unpublish, practice scoring and duplicate retry, teacher progress, role-escalation denial and diagnostic payload validation. An isolated engine snapshot was restored and those invariants revalidated.

The concurrent-session suite also passed against a separate native PostgreSQL 17.10 server bound to localhost. Independent connections verified that simultaneous acceptance creates one match, simultaneous submissions apply ELO once, and concurrent acceptances at the three-match boundary allow only one remaining match. Cleanup removed all five synthetic accounts. `tests/database.integration.cjs` refuses the live project's connection and cleans up its committed fixture in `finally`. Hosted Supabase integration remains a deployment check.

Browser checks cover desktop (1440 px) and mobile (390/320 px), including draft recovery, cancel/close protection, archive/restore, copy, rename, account requests, practice submission retry and mistake review. Additional checks cover removal of reverted drafts, blocked draft discard, keyboard focus containment, cancellation of modal replacement, account-request loading retry/pending state, and late name-save responses preserving a newly opened modal.

The live Supabase accepted recovery and resend HTTP requests with status 200. The supplied test email was not registered, and the user received no messages. **Delivery, confirmation and recovery links are not verified.** No test account or SMTP provider was created. No pilot was performed.

## Deploy in this order

1. Configure a private administrator database connection and age encryption key, create an encrypted backup, and verify restoration in an empty disposable PostgreSQL 17 database. Keep the private age identity off GitHub and out of this repository.
2. Review and explicitly approve `supabase/migrations/20261009070651_account_learning_reliability.sql`. It adds columns/tables/functions and changes access helpers and match-limit checks. It does not delete normal-user accounts or existing matches. Class archiving deliberately invalidates class invitation codes.
3. Apply the migration to a disposable Supabase test project containing the earlier migrations. Run `pnpm test:integration` with `SCHOLA_TEST_DATABASE_URL` supplied privately. The test will not accept the live project ref.
4. After approval, apply the migration to the live database **before** publishing the updated frontend. The new frontend requires its RPCs. Check security and performance advisors; verify anonymous denial and student/teacher ownership with dedicated test accounts.
5. Configure Auth Site URL and exact recovery/confirmation redirect URLs. Register a test account, configure custom SMTP and verify received confirmation/reset links in the browser. Do not put SMTP credentials in the frontend.
6. Publish the updated frontend. Run account, teacher and student checks. A normal user must not be able to grant themselves teacher access.
7. Enable operational jobs only after the preceding checks: set private GitHub secrets `SCHOLA_DATABASE_URL`, `SCHOLA_BACKUP_RECIPIENT` and repository variable `SCHOLA_OPERATIONS_ENABLED=true`. The workflow retains encrypted backup artifacts for seven days. Restore drills need a separate private age identity and `SCHOLA_RESTORE_DATABASE_URL`.

## Backup commands

Install PostgreSQL 17 client tools, Python 3 and age on the administrator's machine. Supply secrets through private environment configuration; do not paste them into source files or chat.

```text
python operations/backup.py backup --directory backups
python operations/backup.py verify-restore --file backups/BACKUP.dump.age --identity PRIVATE_IDENTITY_FILE --disposable
```

The restore command checks the encrypted file's SHA-256 manifest, refuses the live project ref, refuses targets with existing app/auth tables, and never uses `--clean`. Decrypted data streams through pg_restore into psql; pg_restore emits a transaction and psql stops on SQL errors. All three process exit codes are checked. No plaintext dump is written to disk, and the private connection stays in the environment. The manifest is marked verified only after a real restore and core-schema check. An isolated engine snapshot check is not a substitute for restoring a real encrypted production backup. Backups omit storage binaries; this app currently uses no Storage objects. Managed Auth recovery should follow Supabase's documented migration/restore procedures.

## Rollback

Prefer rolling back the frontend to commit `480e71a`; the migration is additive and retains the fields/RPCs that frontend uses. Keep the new schema and its stricter access and match-limit checks in place. Disable the operational workflow variable if a maintenance issue is suspected. Do not drop data-bearing new tables to undo a frontend release.

If database recovery is needed, restore the encrypted backup into a fresh isolated database, verify counts, auth behavior, RLS and matches, then plan a controlled recovery/cutover. Never test restore over the live database. A change rollback and a data restore are different procedures.

## Administrator work and retention

Use `operations/admin-requests.sql` to inspect requests and approve verified teachers. Schools must assign a responsible administrator and decide their record-retention requirements before school use. Deletion requests stay pending until their real deletion/anonymization procedure is completed; requesting or cancelling deletion does not delete an account.

Run `private.purge_operational_data()` daily: error codes expire after 30 days, practice history after 365 days, and cancelled/rejected/completed requests after 90 days. The workflow is disabled until configured. Archived classes, chapters, matches and ratings are retained for administrator review; there is no automatic destruction of historical match records.

For incident triage, a database administrator can read `private.client_errors` grouped by context/code. Clients cannot read the diagnostic table. Configure GitHub workflow failure notifications for backup/maintenance errors. Leaked-password protection was reported disabled by the existing project's security advisor and needs an Auth settings check.

## Current external blockers

Automatic approval review rejected the live migration because it is a broad security/schema change without explicit approval of the exact migration and a verified backup/rollback. It also rejected committing concurrency-test fixtures into the live database. Neither operation was carried out or retried indirectly. Local validation and all independent implementation work continued.

Live deployment requires explicit approval plus a verified backup. SMTP and a disposable hosted test/restore database are not configured. Native PostgreSQL concurrency checks passed, but a real encrypted production backup/restore is unverified. Windows application control blocked the downloaded age executable, and the available embedded PostgreSQL package does not include pg_dump/pg_restore. No application-control bypass was attempted; use an administrator environment with approved PostgreSQL client tools and age for the encrypted restore drill.

References: [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [Backups](https://supabase.com/docs/guides/platform/backups), [Password security](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
