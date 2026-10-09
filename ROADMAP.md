# Schola Clash: roadmap

## Where the project is now

The browser is online-only, with authenticated student and teacher workspaces. The shared schema, invitation codes, atomic chapter publishing, challenges, matches, answer review, stream ratings, full-chapter practice, teacher progress, and clickable student profiles are deployed. The project owner has created test accounts and manually tested the app.

## Current phase: reliability before the pilot

- Done: isolated full browser workflows on desktop and two mobile widths, plus the existing 24 account/profile/layout checks.
- Done: temporary device-local ranked answer recovery, duplicate-click prevention, submission error handling, and ignoring late submission responses after sign-out.
- Covered: reload, failed requests, lost acknowledgement after a saved submission, invalid/expired drafts, account isolation, blocked browser storage, and expired-match display.
- Deployment check: acceptance, submission, and match refresh functions use row locks and cannot be executed by the anonymous role.
- Done: short shared ranked timers, second-by-second countdowns anchored to server time, and answering disabled after expiry. Practice remains untimed.
- Done: transactional database checks of actual duration, immutable deadlines, late-answer rejection, forfeit/no-contest, scoring/ELO, and duplicate completed submissions. All synthetic data is rolled back.
- Remaining: simultaneous acceptance/submission, match-limit boundaries, and cross-class access checks in a disposable classroom. Browser fixtures do not establish these guarantees.

Account recovery, display-name editing, and first-use onboarding are implemented in the browser. Recovery email delivery and allowed redirect URLs still need a live deployment check. After this phase, verify security and operational recovery, run a small classroom pilot, and prioritize new features from its feedback. Material generation and additional game modes are deferred until after the pilot.

## 1. Lock and implement the duel rules — complete

- A **chapter** is the unit that owns its question pool and three-match limit.
- A student is offered up to three ranked matches per chapter. An invitation uses no match until accepted. Accepting it uses one, even if the student later leaves it unfinished.
- An invitation expires three hours after it is issued if it is not accepted. On acceptance, a shared server timer starts: one minute per sampled question, at least five minutes. Exiting, reopening, or refreshing does not pause or extend it. If one submits, the other forfeits on expiry; if neither submits, the match becomes a no-contest. Players must be ready before accepting. Existing matches retain their original deadlines.
- Forfeits and no-contests count against the accepted-match limit but do not change ELO in the prototype. Normal ELO changes only when both answers are submitted.
- Each match draws at least five questions and at most one third of the chapter pool, chosen randomly and shared by both players.
- Answer options are shuffled per pupil and saved with the attempt, so the correct answer appears under different letters for each opponent. Practice shuffles options too.
- One ELO rating is used across chapters within a teacher stream. Completed matches update it from correct-answer scores with K = 32. In a tie, the lower-rated player gains points and the higher-rated player loses the same amount; equal-rated players do not move.
- Speed bonuses are excluded from the first release. Revisit only after comparing device, connectivity, accessibility, and live-versus-asynchronous fairness.

**Complete in prototype:** accepted-match counting, invitation expiry/cancellation, shared short match deadlines, forfeit and no-contest handling, stream ELO and tie handling, visible rating changes, and per-pupil answer shuffling.

## 2. Build the shared classroom foundation — implementation complete

Replace browser-only state with a backend and shared database. Start with teacher and student accounts, teacher-owned streams and classes, and invitations to join. Store chapters, questions, publication state, challenges, attempts, answers, results, and match limits.

Enforce roles and class access on the server. Keep answer keys private until both players submit. Make challenge acceptance, timed deadlines, and the three-match limit safe when concurrent requests arrive. Keep question generation out of this milestone so the first backend can validate the core duel loop.

**Implementation done when:** the app can create a teacher space, issue class codes, accept students, publish chapters, and run matches through Supabase RPCs with row-level access rules. **Pilot check remaining:** two students on separate devices complete the full flow and independently see the same result and stream rating.

## 3. Improve learning after each duel

- Show the correct answers and explanations after both players submit.
- Let students restart the whole chapter without affecting ranked results.
- Add a “review missed questions” practice round.
- Show teacher accuracy by student, class, and chapter.

**Done when:** students can act on what they missed and teachers can spot a chapter their class needs to revisit.

## 4. Add teacher material workflows

Build in this order:

1. Let teachers paste or type source material.
2. Generate draft questions from that material.
3. Link every generated question to its source passage.
4. Let the teacher edit, reject, or approve each question before publishing.
5. Add photo upload and OCR, with a correction step for extracted text.

Generated questions must remain unpublished until a teacher approves them. Record edits and rejections so question quality can be improved.

**Done when:** a teacher can turn a short source into a reviewed, publishable chapter without leaving the product.

## 5. Pilot with one teacher stream

Start with one subject, one teacher, and parallel classes in the same stream. Observe real use before adding more game modes. Track teacher preparation time, question acceptance/edit/rejection, challenge acceptance, match completion, return to practice, and repeat use for another chapter.

Do not treat match count or leaderboard position as evidence of learning. Check whether students improve on missed questions after review.

**Done when:** the teacher repeats the workflow for another chapter and students return to review without prompting from the product team.

## 6. Validate ratings and consider additional modes

The prototype has a basic stream-level ELO calculation. Before using it with real classes, validate rating changes over many matches, expose rating history, and decide whether ratings reset by school year or remain in the stream. Keep correct-answer totals visible alongside ELO.

Consider online live duels only if pilot feedback supports them. Consider speed scoring only after a fairness study. Add seasons, teams, or class-versus-class events only if asynchronous duels are already being used regularly.

## 7. Prepare for school use

- Collect as little student information as possible and define retention and deletion.
- Add teacher controls for class membership, published chapters, and inappropriate content.
- Add backups, error reporting, and recovery after connection loss.
- Review requirements for intended schools and age groups in Kazakhstan before onboarding real students.

## Next work session

1. Add an opt-in backend integration suite using dedicated accounts and a disposable classroom, with no normal-user data changes.
2. Test simultaneous requests, ELO calculation, deadlines, match limits, and unauthorized access against the actual database.
3. Verify recovery email delivery and allowed redirect URLs on the deployment, then prepare operational recovery and a one-class pilot.
