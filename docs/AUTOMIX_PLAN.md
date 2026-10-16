# Professional Automix Plan

Goal: automix quality on par with a skilled club DJ — tight beatmatching, phrase-aligned transitions,
harmonic awareness, band-separated EQ mixing (never two lows / mids / highs at full together),
consistent loudness, no clipping.

## Decisions (2026-10-16)

| Topic | Decision |
|---|---|
| Genre focus | 4/4 electronic first (house, deep house, nu-disco, techno). Other genres later. |
| License | Personal use only. GPL/AGPL libraries allowed (essentia.js OK). |
| Tempo policy | **Native-first.** Sets span wide ranges (e.g. 100 → 128 BPM). Each track plays at its original BPM as much as possible. Deviation of up to ±10% around transitions is acceptable. |
| Auto key shift | Allowed, ±1 semitone max, only when both key detections are high-confidence. |
| Mix export to WAV | Not needed now. Offline render is kept only as a test harness. |

## Current state (why the engine is replaced)

| Area | Now | Problem |
|---|---|---|
| Beat grid | One BPM rounded to 0.1 (`bpmAnalyzer.ts:18`) + single `firstBeatTime` | 0.05 BPM error ≈ 23 ms drift over 32 bars at 128 BPM (audible flam). No downbeat, no phrases. |
| Onsets | `calculateFrameMagnitudes` (`bpmAnalyzer.ts:394`) chunks time-domain samples | Not a real spectral flux; weak beat-phase accuracy. |
| Transition start | rAF polling (`automixController.ts:85`) + `source.start(0, …)` (`playbackEngine.ts:84`) | ±16 ms jitter, stalls when window is hidden. |
| Crossfade | rAF + React dispatch per frame (`automixController.ts:112`) | Zipper noise; timing tied to UI thread. |
| Frequency control | Source → gain → destination (`playbackEngine.ts:79`) | No EQ at all; both basslines at full through the whole fade. |
| Key | None | No harmonic mixing. |
| Key lock | SoundTouch on deprecated `ScriptProcessorNode` (`stretchEngine.ts:85`) with its own gain → destination | Crossfader never reaches stretch-mode audio (`mixingEngine.ts:28`). Rate mode shifts pitch. |
| Gain | New GainNode at 1.0 on every play/seek (`playbackEngine.ts:76`); fader and crossfader write the same node | Volume jumps; no loudness matching; no limiter. |
| Automix | `automix.enabled` stored (`AppContext.tsx:44`) but unused; next track seeks to first beat (`automixController.ts:56`) | No queue, no auto-advance, no cue selection. |
| Rate change while playing | `setDeckPlaybackRate` does not rebase `startTime` | Reported position wrong after sync → bar math wrong. |
| Tests | None | Quality not measurable. |

Keep: UI shell, library, decoding, metadata, persistence. Replace: audio engine, analysis, automix.

## Target architecture

```
Deck A: Stretch worklet ─► Trim (LUFS) ─► 3-band isolator (LR4) ─► Filter HP/LP ─► Channel fader ─┐
Deck B: Stretch worklet ─► Trim (LUFS) ─► 3-band isolator (LR4) ─► Filter HP/LP ─► Channel fader ─┤
                                                                                                  ▼
                                                                Master bus ─► True-peak limiter ─► out
                                                                                └► meters / analysers
```

- Transport runs on the AudioContext clock. A transition is a fully precomputed plan; every AudioParam
  event, deck start and tempo ramp is scheduled up front. React never drives audio timing.
- Analysis runs in a Web Worker with a versioned cache (`analyzerVersion` in the cache key).
- Electron `webPreferences.backgroundThrottling: false`.

```
src/audio/engine/    AudioEngine, Deck, Transport, MasterBus
src/audio/dsp/       lr4Isolator, filters, limiter.worklet
src/audio/analysis/  worker, onset, beatgrid, downbeat, structure, key, loudness, bands (essentia.js where it wins)
src/audio/mix/       compatibility, tempoPlan, mixPoints, templates, planner, validator, sequencer
```

## 1. Beat sync

- **Beat grid:** beat positions (essentia.js `RhythmExtractor2013` multifeature, or own spectral-flux +
  DP tracker — pick by benchmark) → least-squares line fit over the whole track → BPM to 0.001 + offset.
  High residual → "variable tempo" flag + anchor points.
- **Downbeats:** score each of the 4 beat phases by kick-band onset strength + chroma change.
- **Phrases:** per-bar features → novelty curve → boundaries snapped to 8/16/32 bars → labels
  intro / build / drop / breakdown / outro.
- **Sample-accurate start** on the outgoing track's phrase downbeat via scheduled `when`.
- **Phase-lock loop** during overlap: per-beat comparison of expected vs actual input position →
  micro rate correction (≤ 0.1%) keeping error < 2 ms.

### Tempo policy: native-first

Each track plays at its original BPM for its body. Tempo deviates only around transitions, and the
deviation is split between both tracks so neither moves far from native.

- **Overlap tempo `T*`:** constant during the blend (keeps the phase lock simple). Chosen to minimise the
  larger of the two deviations: `T* = sqrt(A × B)` (geometric mean), clamped so each track stays within ±10%.
- **Ramps happen in solo sections only**, with key lock on so pitch never moves:
  - outgoing ramps native → `T*` in the bars before the incoming track enters;
  - incoming ramps `T*` → native after the outgoing track is gone.
  - Slope limit ≈ 0.5% per bar (configurable), so a 5% move takes ~10 bars.
- **Small gaps (Δ ≤ 2%):** only the incoming track adjusts; it glides back to native after the mix.
- **Bridgeable range:** with ±10% per side, Δ up to ~21% (e.g. 100 → 121 meets at 110).
- **Larger gaps (e.g. 100 → 128):** no beatmatched blend. Use echo-out / filter / phrase cut, or let the
  sequencer avoid that adjacency.
- **Sequencer:** for a set like 100 → 128, "smart order" prefers a gradual climb with steps ≤ ~8%
  (each side ≤ 4% around the blend) and compatible keys.

## 2. Harmonic mixing

- **Key source:** file tag first (`music-metadata` `common.key`, written by Mixed In Key / Traktor),
  else detect (essentia.js `KeyExtractor` with EDM profile, or own chroma + key profiles — pick by
  benchmark) → key + confidence → Camelot code.
- **Key lock always on in automix** (Signalsmith Stretch, MIT, WASM AudioWorklet).
- **Compatibility (Camelot):** same 1.0 · ±1 or relative 0.9 · +2 0.6 · +7 (semitone up) 0.5 · other 0.
- **Auto key shift:** shift the incoming track ±1 semitone when that turns a clash into a compatible
  pair and both key confidences are high. The shift stays for the whole track; the next transition
  uses the shifted key.
- **Effect on transition:** compatible → long blend, melodic overlap allowed. Clash → 4–8 bar blend,
  incoming mids killed until the swap, overlap only percussive sections, or a non-blend transition.

## 3. Frequency mixing

Per-deck 3-band isolator: Linkwitz-Riley 4th-order crossovers at ≈ 200 Hz / 2.5 kHz (configurable),
allpass phase compensation on the low band so the bands sum flat; each band can be fully killed.
All band moves are AudioParam ramps.

| Band | Content | Rule |
|---|---|---|
| Low < 200 Hz | kick, bass | Exactly one deck owns the low band at any time. Incoming low killed until the bass swap, which happens on a phrase downbeat within ≤ 1 beat; outgoing low killed at the same instant. |
| Mid 200 Hz – 2.5 kHz | vocals, chords, leads | Never both at 0 dB. Equal-power exchange over several bars. Key clash → mid overlap ≤ 4 bars. |
| High > 2.5 kHz | hats, cymbals | Incoming highs enter first; outgoing highs drop as incoming rise. Never two hat layers at full. |

**Validator:** the analysis stores per-bar band energy for every track. The planner predicts both decks'
band energy through the overlap with the planned EQ gains applied, and rejects a plan when both lows are
above −15 dB (relative) for more than one beat, or any band sum exceeds the louder solo by more than
+3 dB. It then tries the next template or a shorter overlap.

Default template — 32-bar EQ blend:

```
bar  1–8   in: low KILL, mid −12 dB, high −6→0 dB, fader up (equal-power)
bar  9–16  out high 0→−9 dB; in mid −12→−6 dB
bar 17     BASS SWAP on downbeat: out low → KILL, in low → 0 dB
bar 17–24  mid exchange: in → 0 dB, out → −12 dB
bar 25–32  outgoing HPF sweep + fader out; ends on phrase end
```

Other templates: 16-bar blend, 8-bar short blend (key clash), filter transition, echo-out + drop on
downbeat (large tempo gap), breakdown → drop swap.

## Also required

- **Loudness:** integrated LUFS (BS.1770) per track → trim to target (default −10 LUFS). Short-term
  loudness stays within ±1 LU through a transition.
- **Master limiter:** lookahead true-peak limiter worklet, ceiling −1 dBTP.
- **Mix points:** outgoing mix-out = start of an outro phrase with enough bars left for the template plus
  the tempo pre-ramp; incoming mix-in chosen so its main section lands when the outgoing ends.
- **Track order:** score(i → j) = tempo step + key compatibility + energy flow. Modes: keep my order /
  smart order. "Suggest next" in the library.

## Phases

| # | Phase | Delivers | Exit criteria | Size |
|---|---|---|---|---|
| 0 | Engine foundation | New graph, Transport clock, persistent gains, equal-power crossfader, rate/position fix, `backgroundThrottling: false`, Vitest, offline render harness | Two decks start in sync to the sample; no volume jumps | M |
| 1 | Analysis v2 (worker) | Beats, grid fit, downbeats, phrases, per-bar band energy, LUFS, cache v2. Spike: essentia.js vs own code | Click track at 123.45 BPM → grid error < 1 ms over 5 min; downbeat ≥ 90% on 4/4 set | L |
| 2 | Deck DSP | Signalsmith key lock + ±1 st shift + tempo ramps, LR4 isolator, HP/LP filter, trim, limiter; remove SoundTouch + ScriptProcessor | Clean at ±10% by ear; bands sum flat ±0.1 dB; low kill ≥ 40 dB at 60 Hz | M |
| 3 | Key | Tag read + detector + Camelot + compatibility | ≥ 70% weighted score on GiantSteps Key | S |
| 4 | Transition planner | Tempo plan (native-first), mix points, templates, frequency validator, scheduled automation, phase lock | Offline renders: beat error < 5 ms, 0 low-collision beats outside swap, ±1 LU, peak ≤ −1 dBTP, each track ≤ 10% from native | L |
| 5 | Automix sequencer | Queue, auto-advance, smart order (gradual tempo climb), working "Auto" toggle | 1-hour unattended 100 → 128 BPM set without failures | M |
| 6 | UI | Beat/bar/phrase grid on waveform, Camelot badge, live EQ knobs, transition timeline, manual fixes (grid, cues, key) | Any wrong analysis fixable in < 10 s | M |
| 7 | Optional | Stem separation (Demucs via ONNX) for vocal / drum-level swaps | — | L |

Order: 0 → 1 → (2 ∥ 3) → 4 → 5 → 6.

## Progress

### Phase 0 — done (2026-10-16)

- `src/audio/engine/`: `mixGraph` (persistent input → fader → crossfade → master chain),
  `deckPlayer` (audio-clock anchors, scheduled start, gapless seek), `transport` (playhead and
  bar math), `curves` (equal-power law), `offlineMix` (same graph on an OfflineAudioContext).
- Automix starts the incoming deck on the outgoing bar line via `start(when)` and runs the
  crossfade as AudioParam automation; timers only refresh the UI. Grabbing the crossfader cancels
  the transition. Electron `backgroundThrottling: false`.
- Vitest + `node-web-audio-api`: 14 tests. The same scenarios also run in Chrome's
  OfflineAudioContext: 0-sample error for bar-aligned start, mid-play rate change and seek.
- Live check in Chrome with two click tracks: the incoming deck held a constant offset of
  65 samples (1.5 ms), with no drift. The current analyzer's `firstBeatTime` predicts 65.6
  samples, so the offset comes from analysis error, not the engine.
- Lessons: the audio thread renders ahead of `currentTime`, so rate changes and play-now
  starts are scheduled `SCHEDULE_LEAD` (40 ms) ahead, on a render-quantum edge. k-rate events
  placed exactly on the edge can slip a block, so they go half a frame early.

Carried forward:
- Stretch mode (SoundTouch / ScriptProcessor) is still timer-started and block-granular → Phase 2.
- Switching rate ↔ stretch while playing keeps the rate engine at 1× instead of handing over
  to the stretch engine (pre-existing) → Phase 2 (single key-lock source removes the split).
- Old analyzer picks an arbitrary beat as `firstBeatTime` (34–36 s on test tracks), so automix
  cues the incoming track mid-song and is ~10 ms off per track → Phase 1 (grid, downbeats)
  and Phase 4 (mix-in cues).

## Verification

- `npm run mixlab -- a.mp3 b.mp3` → offline-rendered transition WAV + JSON report: beat alignment error,
  low-band collision beats, loudness deviation, true peak, key compatibility, max tempo deviation per track.
- Unit tests on synthetic signals (click tracks, chords, pink noise) for tempo, grid, key, LUFS.
- Benchmarks on GiantSteps Tempo / Key.
- Blind A/B listening against human DJ transitions on the same track pairs.
