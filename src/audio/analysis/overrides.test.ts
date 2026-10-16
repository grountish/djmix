import { describe, expect, it } from 'vitest';
import { anchoredClock } from './beatClock';
import { fromCamelot } from './key';
import {
  applyOverrides,
  downbeatStep,
  editOverrides,
  effectiveAnalysis,
  resolveOverrides,
} from './overrides';
import type { AnalysisOverrides, AudioAnalysis, GridAnchor, PhraseLabel, TempoMultiplier } from './types';

const HOUSE_PHRASES: [number, PhraseLabel][] = [
  [0, 'intro'],
  [16, 'drop'],
  [48, 'build'],
  [72, 'drop'],
  [120, 'outro'],
];

/** Distinct, repeating levels so re-binning is visible. */
const levels = (count: number, base: number) => Array.from({ length: count }, (_, i) => base - (i % 5) * 3);

function makeAnalysis({
  bpm = 120,
  firstBeatTime = 0.3,
  barCount = 136,
  phrases = HOUSE_PHRASES,
  anchors,
}: {
  bpm?: number;
  firstBeatTime?: number;
  barCount?: number;
  phrases?: [number, PhraseLabel][];
  anchors?: GridAnchor[];
} = {}): AudioAnalysis {
  return {
    analyzerVersion: 3,
    bpm,
    bpmConfidence: 0.9,
    firstBeatTime,
    downbeatConfidence: 0.4,
    tempo: { isConstant: !anchors, residualMs: 1, anchors },
    bars: {
      lowDb: levels(barCount, -10),
      midDb: levels(barCount, -20),
      highDb: levels(barCount, -30),
      bassDb: levels(barCount, -40),
    },
    phrases: phrases.map(([startBar, label], i) => ({
      startBar,
      bars: (phrases[i + 1]?.[0] ?? barCount) - startBar,
      label,
      hasKick: label !== 'build',
      hasBass: label === 'drop',
      energyDb: -10 - i,
    })),
    loudness: { integratedLufs: -9, truePeakDb: -0.5 },
    key: { tonic: 9, mode: 'minor', camelot: '8A', confidence: 0.3, source: 'audio' },
  };
}

/** End of the analysed bars: the default track length in these tests. */
const analysedEnd = (a: AudioAnalysis) => a.firstBeatTime + (a.bars.lowDb.length * 4 * 60) / a.bpm;

/** Level of several bars mixed by weight, as the analyser rounds it. */
function powerMean(...parts: [db: number, weight: number][]): number {
  const total = parts.reduce((s, [, w]) => s + w, 0);
  const power = parts.reduce((s, [db, w]) => s + w * Math.pow(10, db / 10), 0) / total;
  return Math.round(100 * Math.log10(power)) / 10;
}

const phraseStarts = (a: AudioAnalysis) => a.phrases.map((p) => p.startBar);
const lastPhrase = (a: AudioAnalysis) => a.phrases[a.phrases.length - 1];
const phraseTime = (a: AudioAnalysis, bar: number) => a.firstBeatTime + (bar * 4 * 60) / a.bpm;

describe('applyOverrides', () => {
  it('returns the analysis itself when nothing is corrected', () => {
    const analysis = makeAnalysis();
    expect(applyOverrides(analysis, undefined)).toBe(analysis);
    expect(applyOverrides(analysis, {})).toBe(analysis);
    expect(applyOverrides(analysis, { tempoMultiplier: 1, gridOffsetMs: 0, downbeatShift: 0 })).toBe(analysis);
    expect(applyOverrides(analysis, { downbeatShift: 4 })).toBe(analysis); // a whole bar: same downbeat
  });

  it('replaces the key and marks it manual, leaving the grid alone', () => {
    const analysis = makeAnalysis();
    const result = applyOverrides(analysis, { key: '3b' });
    expect(result.key).toEqual({ ...fromCamelot('3B')!, camelot: '3B', confidence: 1, source: 'manual' });
    expect(result.bars).toBe(analysis.bars);
    expect(result.firstBeatTime).toBe(analysis.firstBeatTime);
    expect(applyOverrides(analysis, { key: 'H7' })).toBe(analysis);
  });

  it('×2 doubles the tempo and the bar count while phrases keep their place in time', () => {
    const analysis = makeAnalysis();
    const result = applyOverrides(analysis, { tempoMultiplier: 2 }, analysedEnd(analysis));

    expect(result.bpm).toBe(240);
    expect(result.firstBeatTime).toBe(0.3);
    expect(result.bars.lowDb).toHaveLength(272);
    expect(result.bars.lowDb).toEqual(analysis.bars.lowDb.flatMap((v) => [v, v]));
    expect(result.bars.bassDb).toEqual(analysis.bars.bassDb.flatMap((v) => [v, v]));
    expect(phraseStarts(result)).toEqual([0, 32, 96, 144, 240]);
    expect(result.phrases.map((p) => p.bars)).toEqual([32, 64, 48, 96, 32]);
    analysis.phrases.forEach((phrase, i) => {
      expect(phraseTime(result, result.phrases[i].startBar)).toBeCloseTo(phraseTime(analysis, phrase.startBar), 9);
      expect(result.phrases[i]).toMatchObject({ label: phrase.label, hasKick: phrase.hasKick, energyDb: phrase.energyDb });
    });
    expect(result.downbeatConfidence).toBe(analysis.downbeatConfidence);
  });

  it('×2 starts on an earlier downbeat when a corrected bar fits before the analysed one', () => {
    const analysis = makeAnalysis({ firstBeatTime: 1.5 }); // bars of 2 s, corrected bars of 1 s
    const result = applyOverrides(analysis, { tempoMultiplier: 2 }, analysedEnd(analysis));

    expect(result.firstBeatTime).toBeCloseTo(0.5, 12);
    expect(result.bars.lowDb).toHaveLength(273);
    expect(result.bars.lowDb[0]).toBe(analysis.bars.lowDb[0]); // unmeasured: nearest bar
    expect(result.bars.lowDb.slice(1)).toEqual(analysis.bars.lowDb.flatMap((v) => [v, v]));
    expect(phraseStarts(result)).toEqual([0, 33, 97, 145, 241]);
    expect(result.phrases[0].bars).toBe(33);
  });

  it('÷2 halves the tempo, averages bar pairs in power and halves the phrases', () => {
    const analysis = makeAnalysis({ bpm: 128 });
    const result = applyOverrides(analysis, { tempoMultiplier: 0.5 }, analysedEnd(analysis));
    const old = analysis.bars.lowDb;

    expect(result.bpm).toBe(64);
    expect(result.firstBeatTime).toBe(0.3);
    expect(result.bars.lowDb).toHaveLength(68);
    result.bars.lowDb.forEach((value, i) => expect(value).toBe(powerMean([old[2 * i], 1], [old[2 * i + 1], 1])));
    expect(phraseStarts(result)).toEqual([0, 8, 24, 36, 60]);
    expect(result.phrases.map((p) => p.bars)).toEqual([8, 16, 12, 24, 8]);
  });

  it('÷2 drops a trailing half bar that would run past the track', () => {
    const analysis = makeAnalysis({ barCount: 137 });
    const result = applyOverrides(analysis, { tempoMultiplier: 0.5 }, analysedEnd(analysis));
    expect(result.bars.lowDb).toHaveLength(68);
    expect(lastPhrase(result)).toMatchObject({ startBar: 60, bars: 8 });
  });

  it('÷2 with an odd shift picks the other half of the analysed beats', () => {
    const analysis = makeAnalysis();
    const result = applyOverrides(analysis, { tempoMultiplier: 0.5, downbeatShift: 1 }, analysedEnd(analysis));
    expect(downbeatStep(0.5)).toBe(1);
    expect(result.bpm).toBe(60);
    expect(result.firstBeatTime).toBeCloseTo(0.8, 12); // analysed beat 1
    expect(result.downbeatConfidence).toBe(1);
  });

  it('a downbeat shift moves bar lines by whole beats and re-bins the bars', () => {
    const analysis = makeAnalysis();
    const result = applyOverrides(analysis, { downbeatShift: 1 }, analysedEnd(analysis));
    const old = analysis.bars.midDb;

    expect(result.bpm).toBe(120);
    expect(result.firstBeatTime).toBeCloseTo(0.8, 12);
    expect(result.downbeatConfidence).toBe(1);
    // Each bar now covers 3 beats of one analysed bar and 1 of the next; the last no longer fits.
    expect(result.bars.midDb).toHaveLength(135);
    result.bars.midDb.forEach((value, i) => expect(value).toBe(powerMean([old[i], 3], [old[i + 1], 1])));
    expect(phraseStarts(result)).toEqual([0, 16, 48, 72, 120]);
    expect(lastPhrase(result).bars).toBe(15);
  });

  it('keeps the first downbeat at or after 0 s, re-indexing bars and phrases', () => {
    const analysis = makeAnalysis(); // first downbeat 0.3 s, beats of 0.5 s
    const result = applyOverrides(analysis, { downbeatShift: -1 }, analysedEnd(analysis));

    // One beat earlier is before 0 s, so the next bar line (3 beats after the analysed one) leads.
    expect(result.firstBeatTime).toBeCloseTo(1.8, 12);
    expect(result.bars.lowDb).toHaveLength(135);
    expect(phraseStarts(result)).toEqual([0, 15, 47, 71, 119]);
    expect(result.phrases[0].bars).toBe(15);
  });

  it('a grid offset moves the beats, keeping bars inside the track', () => {
    const analysis = makeAnalysis();
    const later = applyOverrides(analysis, { gridOffsetMs: 10 }, analysedEnd(analysis) + 1);
    expect(later.firstBeatTime).toBeCloseTo(0.31, 12);
    expect(later.bars.lowDb).toHaveLength(136);
    expect(later.phrases).toEqual(analysis.phrases);

    // Without a known duration only the analysed span is trusted: the last bar now overhangs it.
    expect(applyOverrides(analysis, { gridOffsetMs: 10 }).bars.lowDb).toHaveLength(135);
  });

  it('an offset pushing the first downbeat before 0 s moves it to the next bar', () => {
    const analysis = makeAnalysis({ firstBeatTime: 0.003 });
    const result = applyOverrides(analysis, { gridOffsetMs: -5 }, analysedEnd(analysis));
    expect(result.firstBeatTime).toBeCloseTo(1.998, 12);
    expect(result.bars.lowDb).toHaveLength(135);
    expect(result.bars.lowDb[0]).toBe(analysis.bars.lowDb[1]);
    expect(phraseStarts(result)).toEqual([0, 15, 47, 71, 119]);
  });

  it('drifting tracks: anchors follow the tempo, the downbeat and the offset', () => {
    // 120 BPM slowly speeding up; anchors at window centres like the analyser's.
    const timeOf = (beat: number) => 0.3 + beat * 0.5 - beat * beat * 1e-5;
    const anchors = Array.from({ length: 130 }, (_, i) => ({ beat: 3.5 + 4 * i, time: timeOf(3.5 + 4 * i) }));
    const source = anchoredClock(anchors, 0.5);
    const analysis = makeAnalysis({ anchors, firstBeatTime: source.timeOf(0) });
    const overrides: AnalysisOverrides = { tempoMultiplier: 2, downbeatShift: 0.5, gridOffsetMs: 5 };
    const result = applyOverrides(analysis, overrides, analysedEnd(analysis));

    expect(result.bpm).toBe(240);
    expect(result.tempo.anchors).toHaveLength(anchors.length);
    result.tempo.anchors!.forEach((a, i) => expect(a.time).toBeCloseTo(anchors[i].time + 0.005, 12));

    const clock = anchoredClock(result.tempo.anchors!, 60 / result.bpm);
    expect(clock.timeOf(0)).toBeCloseTo(result.firstBeatTime, 12);
    expect(result.firstBeatTime).toBeGreaterThanOrEqual(0);
    for (let beat = 0; beat < 400; beat += 7) {
      // Every corrected beat sits on an analysed half-beat (moved by the offset)…
      const analysed = source.beatAt(clock.timeOf(beat) - 0.005);
      expect(analysed * 2).toBeCloseTo(Math.round(analysed * 2), 6);
      // …and downbeats on the analysed beat 0.5 + 2k.
      const bars = (analysed - 0.5) / 2;
      if (beat % 4 === 0) expect(bars).toBeCloseTo(Math.round(bars), 6);
    }
  });

  it('keeps the analysis invariants for every combination', () => {
    const multipliers: TempoMultiplier[] = [0.5, 1, 2];
    for (const firstBeatTime of [0, 0.2, 1.7]) {
      const analysis = makeAnalysis({ firstBeatTime });
      const duration = analysedEnd(analysis) + 0.7;
      for (const tempoMultiplier of multipliers) {
        for (let steps = -3; steps <= 3; steps++) {
          for (const gridOffsetMs of [-20, 0, 7]) {
            const downbeatShift = steps * downbeatStep(tempoMultiplier);
            const result = applyOverrides(analysis, { tempoMultiplier, downbeatShift, gridOffsetMs }, duration);
            const beat = 60 / result.bpm;
            const bar = 4 * beat;
            const count = result.bars.lowDb.length;

            expect(result.bpm).toBe(120 * tempoMultiplier);
            // First downbeat at or after 0 s, on the corrected grid.
            expect(result.firstBeatTime).toBeGreaterThanOrEqual(-1e-9);
            expect(result.firstBeatTime).toBeLessThan(bar + 1e-9);
            const draft = firstBeatTime + downbeatShift * 0.5 + gridOffsetMs / 1000;
            const bars = (result.firstBeatTime - draft) / bar;
            expect(bars).toBeCloseTo(Math.round(bars), 9);
            // Whole bars inside the track, as many as fit.
            for (const band of ['midDb', 'highDb', 'bassDb'] as const) expect(result.bars[band]).toHaveLength(count);
            expect(result.firstBeatTime + count * bar).toBeLessThanOrEqual(duration + 1e-9);
            expect(result.firstBeatTime + (count + 1) * bar).toBeGreaterThan(duration);
            // Phrases tile the bars from bar 0, in the original order.
            expect(result.phrases[0].startBar).toBe(0);
            result.phrases.forEach((p, i) => {
              expect(p.bars).toBeGreaterThan(0);
              expect(p.startBar + p.bars).toBe(result.phrases[i + 1]?.startBar ?? count);
            });
            const ids = analysis.phrases.map((p) => p.energyDb);
            const kept = result.phrases.map((p) => ids.indexOf(p.energyDb));
            expect(kept).toEqual([...kept].sort((a, b) => a - b));
          }
        }
      }
    }
  });
});

describe('effectiveAnalysis', () => {
  const analysis = { ...makeAnalysis(), analyzedAt: '2026-10-16T00:00:00Z', cacheKey: 'track.mp3' };

  it('passes uncorrected and unanalysed tracks through', () => {
    expect(effectiveAnalysis({ analysis: null, duration: 300 })).toBeNull();
    expect(effectiveAnalysis({ analysis, duration: 300 })).toBe(analysis);
  });

  it('corrects the analysis and returns the same object until the overrides change', () => {
    const overrides: AnalysisOverrides = { tempoMultiplier: 2, key: '11B' };
    const first = effectiveAnalysis({ analysis, overrides, duration: 300 })!;
    expect(first.bpm).toBe(240);
    expect(first.key.camelot).toBe('11B');
    expect(first.cacheKey).toBe('track.mp3');
    expect(effectiveAnalysis({ analysis, overrides, duration: 300 })).toBe(first);
    expect(effectiveAnalysis({ analysis, overrides: { ...overrides }, duration: 300 })).not.toBe(first);
  });
});

describe('editOverrides', () => {
  const analysis = makeAnalysis(); // 120 BPM, first downbeat 0.3 s
  const edit = (overrides: AnalysisOverrides | undefined, ...edits: Parameters<typeof editOverrides>[2][]) =>
    edits.reduce((current, e) => editOverrides(analysis, current, e), overrides);

  it('steps the tempo octave between ÷2 and ×2', () => {
    expect(edit(undefined, { type: 'tempo', factor: 2 })).toMatchObject({ tempoMultiplier: 2 });
    expect(edit(undefined, { type: 'tempo', factor: 2 }, { type: 'tempo', factor: 2 })).toMatchObject({
      tempoMultiplier: 2,
    });
    expect(edit(undefined, { type: 'tempo', factor: 2 }, { type: 'tempo', factor: 0.5 })).toBeUndefined();
    expect(edit(undefined, { type: 'tempo', factor: 0.5 }, { type: 'tempo', factor: 0.5 })).toMatchObject({
      tempoMultiplier: 0.5,
    });
  });

  it('accumulates nudges without float noise', () => {
    const nudged = edit(undefined, { type: 'nudge', ms: 5 }, { type: 'nudge', ms: 5 }, { type: 'nudge', ms: -1 });
    expect(nudged).toMatchObject({ gridOffsetMs: 9 });
    expect(edit(undefined, ...Array(10).fill({ type: 'nudge', ms: 0.1 }))).toMatchObject({ gridOffsetMs: 1 });
    expect(edit(nudged, { type: 'nudge', ms: -9 })).toBeUndefined();
  });

  it('wraps the downbeat back to no correction after a whole bar', () => {
    const once = edit(undefined, { type: 'downbeat', steps: 1 });
    expect(once).toMatchObject({ downbeatShift: 1 });
    expect(edit(once, { type: 'downbeat', steps: 1 }, { type: 'downbeat', steps: 1 }, { type: 'downbeat', steps: 1 }))
      .toBeUndefined();
  });

  it('keeps the bar line in place across tempo octave changes', () => {
    const shifted = edit(undefined, { type: 'downbeat', steps: 1 }); // downbeat at 0.8 s
    for (const factor of [2, 0.5] as const) {
      const result = applyOverrides(analysis, edit(shifted, { type: 'tempo', factor }));
      const bar = (4 * 60) / result.bpm;
      const bars = (result.firstBeatTime - 0.8) / bar;
      expect(bars).toBeCloseTo(Math.round(bars), 9);
    }
  });

  it('after ÷2 a downbeat step is one analysed beat', () => {
    const result = applyOverrides(analysis, edit(undefined, { type: 'tempo', factor: 0.5 }, { type: 'downbeat', steps: 1 }));
    expect(result.firstBeatTime).toBeCloseTo(0.8, 12);
  });

  it('after ×2 a downbeat step is one corrected beat', () => {
    const result = applyOverrides(analysis, edit(undefined, { type: 'tempo', factor: 2 }, { type: 'downbeat', steps: 1 }));
    expect(result.firstBeatTime).toBeCloseTo(0.55, 12);
  });

  it('records the grid it was made on, and sets or clears the key', () => {
    const overrides = edit(undefined, { type: 'downbeat', steps: 1 }, { type: 'nudge', ms: 4 }, { type: 'key', camelot: '9a' });
    expect(overrides).toEqual({
      downbeatShift: 1,
      gridOffsetMs: 4,
      key: '9A',
      basis: { bpm: 120, firstBeatTime: 0.3, downbeat: expect.closeTo(0.804, 12) },
    });
    expect(edit(undefined, { type: 'key', camelot: '9A' })).toEqual({ key: '9A' });
    expect(edit({ key: '9A' }, { type: 'key', camelot: null })).toBeUndefined();
    expect(edit(overrides, { type: 'reset' })).toBeUndefined();
  });
});

describe('overrides after a re-analysis', () => {
  it('drops a tempo octave fix the new analysis no longer needs', () => {
    const before = makeAnalysis({ bpm: 87 });
    const overrides = editOverrides(before, undefined, { type: 'tempo', factor: 2 });
    expect(applyOverrides(makeAnalysis({ bpm: 87.02 }), overrides).bpm).toBeCloseTo(174.04, 9);
    expect(resolveOverrides(makeAnalysis({ bpm: 174 }), overrides).tempoMultiplier).toBe(1);
    expect(applyOverrides(makeAnalysis({ bpm: 174 }), overrides).bpm).toBe(174);
  });

  it('keeps the chosen downbeat, taking the new beat phase when the user did not nudge', () => {
    const before = makeAnalysis(); // downbeat 0.3 s, moved by the user to 0.8 s
    const overrides = editOverrides(before, undefined, { type: 'downbeat', steps: 1 });
    const after = makeAnalysis({ firstBeatTime: 0.8012 });
    expect(resolveOverrides(after, overrides)).toMatchObject({ downbeatShift: 0, gridOffsetMs: 0 });
    expect(applyOverrides(after, overrides)).toBe(after);
  });

  it('keeps a nudged bar line exactly where the user put it', () => {
    const before = makeAnalysis();
    const overrides = editOverrides(before, editOverrides(before, undefined, { type: 'downbeat', steps: 1 }), {
      type: 'nudge',
      ms: 4,
    });
    const after = makeAnalysis({ firstBeatTime: 0.3012 });
    expect(resolveOverrides(after, overrides)).toMatchObject({ downbeatShift: 1, gridOffsetMs: 2.8 });
    expect(applyOverrides(after, overrides).firstBeatTime).toBeCloseTo(0.804, 12);
  });

  it('leaves a key-only fix alone', () => {
    const overrides: AnalysisOverrides = { key: '4B' };
    const after = makeAnalysis({ firstBeatTime: 1.1, bpm: 99 });
    expect(applyOverrides(after, overrides).key.camelot).toBe('4B');
    expect(applyOverrides(after, overrides).firstBeatTime).toBe(1.1);
  });
});

describe('downbeatStep', () => {
  it('is one corrected beat, or one analysed beat after ÷2', () => {
    expect(downbeatStep(2)).toBe(0.5);
    expect(downbeatStep(1)).toBe(1);
    expect(downbeatStep(0.5)).toBe(1);
  });
});
