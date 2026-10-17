# Active work board

Several Claude sessions commit to this repo at the same time. Before you start, read this
file; add an entry for what you are about to touch; mark it DONE (with the commit) when you
finish; delete entries that are over. Don't edit files another entry lists as in progress.

Shared dev server: Vite on :5173 (+ Electron). The live tests (`npm run test:live`) start their
own Vite on :5174 with HMR off, so edits don't reload the page under a running test.

## Session a131b68b — "10 improvements" batch (main checkout, commits straight to main)

Started 2026-10-17. Order: 1 → 5 → 8 → 6.

1. DONE `9e3aa19` Waveform cache, no decoding at startup.
   `src/audio/waveformCache.ts`, `src/App.tsx` (loadLibrary), `src/store/AppContext.tsx`
   (loadToDeck, UPDATE_TRACK is now a patch), `electron/main.js` + `preload.js` (`waveform:*` IPC).
2. IN PROGRESS Live automix regression test (Playwright, real audio, ~2 min).
   `e2e/automix.spec.ts`, `playwright.config.ts`, `src/testBridge.ts` (`window.__djmix`, dev only),
   `vite.config.ts` (hmr off under `DJMIX_LIVE_TEST`), `package.json` (`test:live`, `@playwright/test`).
3. IN PROGRESS Outro looping: the planner loops an 8-bar kick phrase of the outgoing track when
   fewer than 16 bars are left for the blend.
   `src/audio/mix/mixPoints.ts` (`OutgoingLoop`, loop candidates), `src/audio/mix/planner.ts`,
   `src/audio/mix/runner.ts` ('jump' commands), `src/audio/engine/deckPlayer.ts` (`scheduleJump`),
   `src/audio/automixController.ts` (`describePlan`), tests next to each.
4. NEXT Transition inspector: the upcoming mix drawn on both deck waveforms (entry, swap, loop,
   overlap), with skip / mix-now controls.
   Will touch `src/components/Mixer.tsx`, `Waveform.tsx`, `Deck.tsx`, `src/store/AppContext.tsx`
   (plan preview kept in automix state), `src/store/useAutoDj.ts`, `src/styles/index.css`.
