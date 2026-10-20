# Active work board

Several Claude sessions commit to this repo at the same time. Before you start, read this
file; add an entry for what you are about to touch; mark it DONE (with the commit) when you
finish; delete entries that are over. Don't edit files another entry lists as in progress.

Every feature commit also gets an entry on the feature-log page (CLAUDE.md → "Feature log"):
https://miltonmannarino.github.io/djmix-features/ — what changed, how to test, what's missing.

Shared dev server: Vite on :5173 (+ Electron). The live tests (`npm run test:live`) start their
own Vite on :5174 with HMR off, so edits don't reload the page under a running test.

## Session 6e8d1284 — phrase grid accuracy + more loop mixes — IN PROGRESS (2026-10-20)

User: only 1 of 6 mixes used a loop; the mix often misses the 32-beat (8-bar) phrase. Audit the
phrase grid / downbeat on the real library, fix the analysis, then widen what the loop style
can hold. Files: `src/audio/analysis/structure.ts`, `downbeat.ts`, `beatGrid.ts` (if the
downbeat is the cause), `types.ts` (ANALYZER_VERSION), `src/audio/mix/mixPoints.ts` (+tests),
`fixtures/analysis-baseline.json`, `scripts/analyze*.ts`.

## Session 6e8d1284 — "Loop" mix style — DONE `512961c` (2026-10-19)

MIX picker in the top bar (Blend / Loop, persisted in `mixerPrefs`). Loop: `chooseMixPoints`
style 'loop' also searches the incoming intro's kick-only/no-bass 8-bar phrases held 1–3 extra
times (`IncomingLoop`, `plan.incomingLoop`, released by the swap; incoming bars count along the
looped timeline, `loopedTrackBar` takes `repeats`), and always searches outgoing loops. Runner
sends incoming 'jump's; balance maps the incoming loop; waveform draws "LOOP n×" on the
incoming deck. `npm run test:live` transition 1 is now a loop mix (checks the incoming jump).
mixlab/mixset `--style loop`. Every file is free.

## Session 91b26f74 — Auto mixes out at the end of the track — DONE `e49d972` (2026-10-19)

`chooseMixPoints` ('end'): the overlap ends within a phrase of the outgoing track's end
(`END_SLACK_BARS`), `EARLY_WEIGHT` 0.5 (not for loops), Auto's loop is the last kick phrase and
the blend must reach it. Mix now unchanged. Every file is free.

## Session 91b26f74 — deck loading indicator — DONE `2a65f6e` (2026-10-19)

`DeckState.loading` (the track on its way), `SET_DECK_LOADING` around `loadToDeck` (a later
load on the same deck supersedes an earlier one, which then neither lands nor clears the
indicator), spinner + "Loading <title>" on the deck, `EmptyWaveform({ hint })`. Every file is free.

## Session a131b68b — layout: decks a bit smaller — DONE `63467a9` + `efce872` (2026-10-18)

Stacked mixer kept; knobs shown at 34 px, faders 96 px, tighter gaps; `.wave-main` has a pixel
flex basis (its aspect ratio used to hold the row). Decks row ≈530 px (was 614). `index.css` is free.

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
2. DONE `ed8001b` `6429f8e` `34d5c8c` Grid-free metrics (kickPhaseOffset by envelope
   cross-correlation, bandLevels/checkForecast vs the plan's forecast), bass handover without a
   hole (template lifts the incoming low under its fader, balance may lift it 4 dB, mix points
   penalise bass holes), the filter-start thump (high-pass only ever jumps between exact 0 and
   20 Hz: `settleHighpass`; the rest frequency stays 0, so the DC-fed tests are unchanged),
   "Flag mix" (`recorder.ts`, `report:save`, `BadMixButton.tsx`, one line in `App.tsx`),
   `scripts/mixlabLib.ts` + `scripts/mixset.ts`. Every file is free.
   Follow-ups nobody has taken: the manual GAIN offset isn't in the balance forecast (planner
   would need the decks' trimDb via previewTransition); "Flag mix" is untested in the real app.
3. DONE `dd3521f` `1e7b559` Tag-BPM octave hint (`analyzeAudio(channels, sampleRate, hints)`,
   worker, `App.tsx` call site, analyze + mixlab CLIs; ANALYZER_VERSION 8) and the regression
   harness: `npm run analyze -- <folder> --baseline fixtures/analysis-baseline.json [--update]
   [--library <track-library.json>]` (changes vs baseline, tag agreement, which in-app
   corrections the analyser still needs); baseline committed for the 42-track set. The
   forecast now reads the decks' actual trims (GAIN knob included). Not done: drop/build label
   work in `structure.ts` (nothing to verify it against yet; the harness is where it shows).
   Session ecc91043 finished; every file is free.

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
