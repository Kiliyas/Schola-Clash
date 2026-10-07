# Schola Clash prototype

A lightweight browser prototype for reviewing school material through asynchronous student duels.

## Run locally

Open `index.html` in a modern browser. No dependencies or build step are required.

Use the profile switcher in the top-right corner to walk through the demo:

1. Open the teacher profile and open the **World War I** question set. It contains 15 sample questions.
2. Switch to **Vasya** and choose **Find an opponent**.
3. Answer the five questions in the match.
4. Switch to **Sasha**, open **Challenges**, and accept the match.
5. After Sasha submits answers, both students and the teacher can see the result.

Vasya and Sasha are in parallel classes, Grade 11B and Grade 11A, within the same teacher stream. The teacher can add more demo profiles and create question sets manually.

## Included

- Teacher and student roles, demo classes, and profile switching.
- Manual question set creation and editing with four answer options.
- A 15-question minimum to publish a set for ranked matches.
- Opponent matching across parallel classes in the same stream.
- Asynchronous duels with the same random sample of at least five questions and a three-match limit per set.
- Match results, explanations, match history, and a teacher results table.
- A separate full-set practice mode that does not affect ranked results.
- Browser-local persistence with `localStorage`.

## Prototype limits

This is a local demo. Profiles and matches run in one browser on one device. The stream invite code (`SCHOLA11`) is a UI placeholder and is not connected to account authentication. Data is saved only in the current browser.

Photo uploads, OCR, LLM question generation, live matches, a backend, cross-device sync, and ELO are not implemented yet. The next step toward a multi-user version is an API and shared database, followed by real invite-code sign-in and match synchronization.

To restore the sample data, clear this page's site data or delete the `krug-prototype-v1` key from `localStorage` in browser developer tools.
