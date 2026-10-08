# Schola Clash

An online classroom review app. Teachers prepare chapters and review student progress; students practise and challenge classmates.

## Run

Run a local web server from this folder and open `http://localhost:8000`:

```powershell
python -m http.server 8000
```

There is no build step. The app loads Supabase JS from a CDN and uses the project configured in `supabase/client-config.js`. An internet connection and an account are required. Signing out returns to the sign-in form.

See [supabase/README.md](supabase/README.md) for database setup, access rules, and teacher role assignment.

## Account flow

1. Sign in with an existing account or create an account. Confirm your email if required.
2. New accounts are students. A trusted project administrator assigns teacher access.
3. Teachers create a teaching space and classes, then share class join codes.
4. Students join classes with those codes and open assigned chapters.
5. Students challenge a classmate, submit independently, and return to see both scores and answer explanations.

## Features

- Teacher and student dashboards with responsive layouts.
- Chapter creation, draft saving, editing, and publishing with at least 15 questions.
- Student profiles for teachers, including ELO, class membership, chapter progress, and recent matches.
- Prominent student ELO, with separate ratings for each teacher's teaching space.
- Full-chapter practice with shuffled choices and answer review, without rating changes.
- Up to three accepted ranked matches per chapter, with separate answer-choice ordering for each player.
- Invitations expire after three hours. Accepted matches allow 24 hours to submit.
- Forfeits and no-contests preserve match history and do not change ELO.
- Teachers can remove class members without deleting accounts or match history.
- Server-side validation and row-level access checks.

## Not implemented

Photo or document upload, OCR, question generation, and real-time matches are not available. Speed does not affect ranked scores.

## Browser checks

With the local server running, Playwright available to Node, and Chrome installed, run:

```powershell
node tests/profiles.browser.cjs
```

The checks use isolated online-account fixtures and block external requests and database writes. They cover sign-in, registration, sign-out, account restoration, student profiles, ELO, practice, consumer-facing error messages, and desktop/mobile layouts. Legacy local workspace data is seeded to verify it is ignored.

Screenshots are saved to `schola-profile-smoke` in the system temporary directory. Set `SCHOLA_TEST_URL` to use another local port or `SCHOLA_BROWSER_CHANNEL` to select another installed Chromium browser.
