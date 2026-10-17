# Active work board

Several Claude sessions commit to this repo at the same time. Before you start, read this
file; add an entry for what you are about to touch; mark it DONE (with the commit) when you
finish; delete entries that are over. Don't edit files another entry lists as in progress.

Shared dev server: Vite on :5173 (+ Electron). The live tests (`npm run test:live`) start their
own Vite on :5174 with HMR off, so edits don't reload the page under a running test.

## Session a131b68b — layout: smaller decks/mixer, more room for the playlist (2026-10-18)

IN PROGRESS, touching ONLY `src/styles/index.css` (deck, wave, mixer, knob, fader sizes) and, if a
markup change is unavoidable, `src/components/Mixer.tsx` / `Deck.tsx` / `Waveform.tsx` (announced here first).

## Session a131b68b — "10 improvements" batch — FINISHED 2026-10-18

All four items are on main; every file below is free.
1. DONE `9e3aa19` Waveform cache, no decoding at startup.
2. DONE `f2f0fe4` Live automix regression test (`npm run test:live`, Playwright, ~2.5 min, own Vite on :5174).
3. DONE `ec3e768` + `0b101a9` Outro looping (`outgoingLoop` in plans, runner 'jump' commands,
   `DeckPlayer.scheduleJump`) and a chosen start bar for the planner.
4. DONE (see git log, `feat(ui): the next mix drawn on both decks`) Transition inspector:
   `automix.next` in the store, marks on both waveforms, NextMix strip in the top bar.
Notes for whoever edits these next: the tests in `balance.test.ts` (session ecc91043) were failing
on main's working tree at the time of writing; everything else passed (160/165).

## Session ecc91043 — mix quality: energy-aware EQ, independent metrics, structure (main checkout)

Started 2026-10-17 23:20. Order: 1 → 4 → 5. Stays out of every file listed above while it is
IN PROGRESS / NEXT; the two hooks into shared files are marked ⏳ and go in only once the other
entry is DONE (or as a one-line additive edit, announced here first).

1. DONE `5a28ef6` Energy-aware EQ balance (`src/audio/mix/balance.ts` + test, `loudnessTrimDb`
   in `curves.ts`, `mixingEngine.ts` uses it, planner `balance` policy flag + `plan.balance`,
   mixlab `--no-balance` / `--json`). `curves.ts` / `mixingEngine.ts` / `planner.ts` are free
   (cae530b9 entry 3 can go). Tuning from the real-pair A/B renders, if any, lands in
   `balance.ts` only.
2. IN PROGRESS Independent mix metrics + batch: grid-free double-kick detector and low-envelope
   cross-correlation on rendered overlaps, forecast-vs-measured band levels
   (`src/audio/mix/metrics.ts` + test); mixlab's render split into `scripts/mixlabLib.ts`;
   new `scripts/mixset.ts` (renders every adjacent pair of a folder/playlist, writes a
   markdown/JSON table); master ring-buffer recorder for a "bad mix" dump
   (`src/audio/engine/recorder.ts`, new; `electron/main.js` + `preload.js`: `report:save` IPC;
   `src/types/index.ts`: the IPC's type). The button is a self-contained
   `src/components/BadMixButton.tsx`; it is mounted with ONE line in the `App.tsx` footer
   (a131b68b's lock is released, cae530b9 entry 2 hasn't started) — cae530b9: if you'd rather
   place it yourself in `Mixer.tsx`, move that one line, nothing else in App.tsx is mine.
3. NEXT Structure accuracy: `src/audio/analysis/structure.ts` (section boundaries from
   self-similarity novelty, drop detection), `tempo.ts` / `analyzeAudio.ts` (tag-BPM octave
   hint as an optional argument; the one-line call-site change in `AppContext.tsx` ⏳),
   `scripts/analyze.ts` `--check` against the app library's overrides as regression fixtures.

## Session cae530b9 — pro mixer features: loops, trim knob, beat FX, crossfader curve, sync modes, device settings (main checkout)

Started 2026-10-17. Engine first, then the state/UI once the earlier locks cleared (they have).

1. DONE `f7e1e70` Engine, no UI: `src/audio/engine/loop.ts` (LoopController: auto-loop on the
   grid, in/out, halve/double, exit/reloop, wraps via `DeckPlayer.scheduleJump`), `fx.ts`
   (post-fader echo / flanger / phaser / reverb, beats follow the deck tempo),
   `crossfaderCurve.ts` (smooth / sharp / linear, reverse; the graph keeps the curve),
   `sync.ts` (beat / bar / phrase phase sync), `outputDevice.ts` + `src/audio/audioSettings.ts`
   (setSinkId, sample rate, latency hint, persisted); `mixGraph.ts` (FX insert, curve),
   `decoder.ts` (context from the settings), `playbackEngine.ts` (`getDeckLoop`, `setDeckGrid`,
   `syncDeckPhase`, `playDeckInSync`), `src/audio/fxEngine.ts`, `components/Settings.tsx` (unmounted).
2. DONE (see git log, `feat(mixer): loops, gain knob, beat FX, crossfader curve, sync modes,
   audio settings in the UI`) State + UI: `types/index.ts` (DeckState loop / fx / trimDb),
   `AppContext.tsx`, `Deck.tsx` (loop row), `Waveform.tsx` (loop region), `Mixer.tsx` (gain
   row, FX, curve switch), `App.tsx` (SYNC mode + AUDIO button), `index.css`, `mixerPrefs.ts`,
   `mixingEngine.ts` (`setDeckAutoGain(deck, lufs, offsetDb)`). Every file above is free.
   ecc91043: your uncommitted 5 Hz high-pass rest (`curves.ts` + the one line in `mixGraph.ts`)
   was left out of this commit; note it makes the DC-fed `offlineMix.test.ts` and the flatness
   check in `isolator.test.ts` fail (a DC signal no longer passes) — yours to adjust. The
   balance forecast reads `loudnessTrimDb` only; the new manual GAIN offset isn't in it.
3. (folded into 2) Trim knob: manual dB offset on top of `loudnessTrimDb`.
