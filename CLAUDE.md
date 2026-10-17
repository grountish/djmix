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
