# Active work board

Several Claude sessions commit to this repo at the same time. Before you start, read this
file; add an entry for what you are about to touch; mark it DONE (with the commit) when you
finish; delete entries that are over. Don't edit files another entry lists as in progress.

Shared dev server: Vite on :5173 (+ Electron). The live tests (`npm run test:live`) start their
own Vite on :5174 with HMR off, so edits don't reload the page under a running test.

## Session a131b68b — "10 improvements" batch (main checkout, commits straight to main)

Started 2026-10-17. Order: 1 → 5 → 8 → 6.

1. DONE `9e3aa19` Waveform cache, no decoding at startup.
2. DONE `f2f0fe4` Live automix regression test (`npm run test:live`, Playwright, ~2.5 min, own Vite on :5174).
3. DONE `ec3e768` + `0b101a9` Outro looping (`outgoingLoop` in plans, runner 'jump' commands,
   `DeckPlayer.scheduleJump`) and a chosen start bar for the planner. `planner.ts` / `mixPoints.ts` /
   `runner.ts` / `deckPlayer.ts` are free again.
4. IN PROGRESS Transition inspector: the upcoming mix drawn on both deck waveforms (entry, swap,
   loop), earlier/later/skip controls in the top bar. Touching ONLY:
   `src/store/AppContext.tsx` (automix.next / startBar state + actions, triggerAutomix),
   `src/store/useAutoDj.ts`, `src/App.tsx`, `src/components/Deck.tsx`, `src/components/Waveform.tsx`,
   new `src/components/NextMix.tsx`, `src/styles/index.css`.

## Session ecc91043 — mix quality: energy-aware EQ, independent metrics, structure (main checkout)

Started 2026-10-17 23:20. Order: 1 → 4 → 5. Stays out of every file listed above while it is
IN PROGRESS / NEXT; the two hooks into shared files are marked ⏳ and go in only once the other
entry is DONE (or as a one-line additive edit, announced here first).

1. IN PROGRESS Energy-aware EQ balance: the planner predicts both decks' per-band level through
   the overlap (analysed bar energies + trim + template gains) and corrects the EQ lanes so each
   band's sum follows a reference (outgoing level → incoming level). Replaces the fixed template.
   New `src/audio/mix/balance.ts` (+ `balance.test.ts`); `src/audio/engine/curves.ts`
   (`loudnessTrimDb`, shared trim law); `src/audio/mixingEngine.ts` (uses it);
   `scripts/mixlab.ts` (`--no-balance`, predicted vs measured bands).
   ⏳ `src/audio/mix/planner.ts`: one call `balanceLanes(...)` where `lanes` is built, plus a
   `balance` policy flag — after entry 3 above is DONE.
2. NEXT Independent mix metrics + batch: grid-free double-kick detector and low-envelope
   cross-correlation on rendered overlaps (`src/audio/mix/metrics.ts` + test); `scripts/mixset.ts`
   (renders every adjacent pair of a folder/playlist, writes a markdown/JSON table); master
   ring-buffer recorder for a "bad mix" dump (`src/audio/engine/recorder.ts`, new;
   `electron/main.js` + `preload.js`: `report:save` IPC).
   ⏳ The "bad mix" button itself needs a spot in the status bar / mixer: will ask here before
   touching `Mixer.tsx` / `AppContext.tsx`.
3. NEXT Structure accuracy: `src/audio/analysis/structure.ts` (section boundaries from
   self-similarity novelty, drop detection), `tempo.ts` / `analyzeAudio.ts` (tag-BPM octave
   hint as an optional argument; the one-line call-site change in `AppContext.tsx` ⏳),
   `scripts/analyze.ts` `--check` against the app library's overrides as regression fixtures.
