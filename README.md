# Schola Clash prototype

An English-language, Kazakhstan-focused classroom review prototype. Teachers create approved chapters, and students challenge classmates asynchronously before practising the full chapter.

## Run

Open `index.html` in a modern browser. The prototype has no build step or dependencies. Data is saved in browser `localStorage` under `schola-clash-prototype-v2`.

## Demo flow

1. Open the **Marina Ivanova · Teacher** profile. The sample **World War I** chapter has 15 questions and is available to Grade 11A and Grade 11B.
2. Switch to **Vasya · Grade 11B**, select **Find an opponent**, and complete the five-question match.
3. Switch to **Sasha · Grade 11A**, open **Challenges**, accept the match, and submit answers.
4. View the result as either student, then switch to the teacher profile to see the results table.

The profile picker simulates separate accounts on one device. **SCHOLA11** is a display-only invitation code; it does not create real accounts.

## In the prototype

- Responsive teacher and student dashboards with an English interface.
- Manual chapter creation, draft saving, editing, and publishing.
- A 15-question minimum per ranked chapter.
- Random opponent selection across the teacher’s included classes.
- Asynchronous matches with the same random question sample for both students.
- Up to three accepted ranked matches per chapter. An open invitation does not use a match; accepting it does.
- Invitations expire after three hours if they are not accepted.
- One ELO rating per teacher stream, updated after a match using correct answers (K = 32). In a draw, a lower-rated student gains rating and the higher-rated student loses the same amount.
- Separate full-chapter practice that does not affect ranked results.
- Answer explanations, student match history, and a teacher results summary.
- Local persistence in the browser.

## Not implemented

There is no server, sign-in, cross-device data, real invite-code flow, photo or document upload, OCR, LLM question generation, or real-time match. Speed does not affect ranked scores. The demo uses local profiles and sample questions only, so its ELO and results exist only in this browser.

For a fresh demo, clear this page’s site data or delete `schola-clash-prototype-v2` from `localStorage` in browser developer tools.
