# Schola Clash prototype

An English-language, Kazakhstan-focused classroom review prototype. Teachers create approved chapters, and students challenge classmates asynchronously before practising the full chapter.

## Run

Run a local web server from this folder, then open `http://localhost:8000`:

```powershell
python -m http.server 8000
```

There is no build step or package install. The app loads Supabase JS from a CDN. Demo workspace data is saved in browser `localStorage` under `schola-clash-prototype-v2`.

## Demo flow

1. Open the **Marina Ivanova · Teacher** profile. The sample **World War I** chapter has 15 questions and is available to Grade 11A and Grade 11B.
2. Switch to **Vasya · Grade 11B** and select **Find an opponent** to send a challenge.
3. Switch to **Sasha · Grade 11A**, accept the challenge, and submit answers.
4. Switch back to Vasya, continue the match, and submit answers. Both students can then view the result.
5. Open **Class & rankings** from a student profile to view classmates and compare class and teacher-stream ELO rankings.
6. Switch to the teacher profile to see the results table.

The profile picker simulates separate accounts on one device. **SCHOLA11** is a display-only invitation code; it does not create real accounts. Sign out of Supabase to return to this demo.

## Live Supabase flow

1. Use **Sign in** in the header to create or sign in to a student account.
2. A trusted project administrator must assign teacher access before a teacher can create a teaching space. New sign-ups are always students.
3. A teacher creates a stream and classes, generates a class code, then writes and publishes a chapter.
4. Students join with the code, open an assigned published chapter, and challenge a classmate. Accepting an invitation creates a ranked match.
5. Each student submits independently. Supabase scores the match and updates stream ELO after both submissions; either player can return later to see the result and answer review.

The live screens read and write shared classroom data in Supabase. The local demo remains available after signing out. See [supabase/README.md](supabase/README.md) for schema, access rules, and setup details.

## In the local demo

- Responsive teacher and student dashboards with an English interface, larger controls, and clearer reading sizes.
- Manual chapter creation, draft saving, editing, and publishing.
- A 15-question minimum per ranked chapter.
- Random opponent selection across the teacher’s included classes.
- Student class view with separate class and teacher-stream leaderboards, both ordered by the shared stream ELO rating.
- Asynchronous matches with the same random question sample for both students.
- Up to three accepted ranked matches per chapter. An open invitation does not use a match; accepting it does.
- Invitations expire after three hours if they are not accepted.
- After acceptance, both players have 24 hours to submit. If only one submits, the other forfeits; if neither submits, the match ends as a no-contest. Forfeits and no-contests do not change ELO.
- Answer choices are shuffled separately for each student; the correct answer appears under different letters for the two players. Choices also shuffle during practice.
- One ELO rating per teacher stream, updated after a match using correct answers (K = 32). In a draw, a lower-rated student gains rating and the higher-rated student loses the same amount.
- Separate full-chapter practice that does not affect ranked results.
- Answer explanations, student match history, and a teacher results summary.
- Teachers can remove a student from a class without deleting their account or past match history.
- Demo profiles and results persist in this browser.

## In the live workspace

- Supabase email/password accounts, with new accounts assigned the student role.
- Teacher workspaces with classes, copyable join codes, chapter drafts, and server-validated publishing.
- Student class membership, published chapters, asynchronous challenges and matches, answer review, and shared stream ELO.
- Teachers can edit published chapters, remove students from classes, and review students' correct-answer totals.
- Click a student's name in classes or results to view their rating, class membership, chapter progress, and recent matches.
- The student dashboard shows ELO and the latest rating change for each teacher stream above the chapter list.
- Students can practise every question in an assigned chapter without changing ranked results and see both players' scores after a match.
- Row-level access checks and server-side validation for writes and match results.

## Not implemented

There is no photo or document upload, OCR, question generation, or real-time match. Live accounts need a configured Supabase project and email confirmation if enabled by the project. Speed does not affect ranked scores.

For a fresh demo, clear this page's site data or delete `schola-clash-prototype-v2` from `localStorage` in browser developer tools.

## Browser checks

With the local server running, Playwright available to Node, and Chrome installed, run:

```powershell
node tests/profiles.browser.cjs
```

The checks use isolated demo and Supabase fixtures, cover student profiles and ELO at desktop and mobile widths, and block external requests and data writes. Screenshots are saved to `schola-profile-smoke` in the system temporary directory. Set `SCHOLA_TEST_URL` to use another local port or `SCHOLA_BROWSER_CHANNEL` to select another installed Chromium browser.
