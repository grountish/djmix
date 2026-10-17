# djmix

Electron + Vite + React DJ mixer with an automix engine (Web Audio, Signalsmith stretch).

## Working alongside other sessions

Other Claude sessions commit to this repo concurrently (some from worktrees under `.claude/worktrees/`).
**Before touching code, read `.claude/active-work.md`**, add an entry for what you will work on,
keep it current, and stay off files another entry has in progress.

## Checks

- `npx tsc --noEmit` and `npm test` (vitest; the RTK wrapper hides output, read `.vitest/json/output.json`).
- `npm run test:live` plays automix in a headless Chromium for ~2 minutes (Playwright, own Vite on :5174).
- Commit on `main`, no attribution lines.

## Feature log (obligatory)

Every commit that adds or changes something a user can notice (a feature, a fix, a behaviour
change; engine-only work included, so the log stays complete) gets an entry on the feature-log
page, in the same session, before the work is reported as done:

- Page: `~/Documents/code/miltonmannarino.github.io/djmix-features/index.html`, published at
  https://miltonmannarino.github.io/djmix-features/ (GitHub Pages, branch `main`, push directly).
- Add one object at the TOP of the `FEATURES` array (newest first): `id`, `area` (an existing key
  of `AREAS`, or add one), `title`, `date`, `session` (your board id), `commits` [{hash, subject}],
  `changed` (what the user sees, one bullet each), `test` { `steps`: concrete steps in the real
  app — control names, clicks, the expected result after a `→`; `automated`: the checks that ran
  and their result }, `missing` [{text, owner}] (open decisions, untested paths, follow-ups; owner
  is a session id, a person, or "unowned").
- If you ran the checks, update the `CHECKS` block (typecheck / vitest / test:live, with the time).
- Commit the page (no attribution), push `main`, then
  `curl -sI https://miltonmannarino.github.io/djmix-features/ | head -1` must return 200.
  Put the link in your report to the user.
