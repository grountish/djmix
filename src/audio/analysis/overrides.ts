import { anchoredClock, type BeatClock, constantClock } from './beatClock';
import { fromCamelot, toCamelot } from './key';
import type {
  AnalysisOverrides,
  AudioAnalysis,
  BarEnergies,
  GridAnchor,
  Phrase,
  TempoMultiplier,
  TrackKey,
} from './types';

const BEATS_PER_BAR = 4;
const MULTIPLIERS: TempoMultiplier[] = [0.5, 1, 2];

/** Overrides with defaults filled in, already re-expressed against the current analysis. */
export interface ResolvedOverrides {
  tempoMultiplier: TempoMultiplier;
  gridOffsetMs: number;
  downbeatShift: number;
  key: string | null;
}

/** One click on the deck's correction controls. */
export type OverrideEdit =
  | { type: 'tempo'; factor: 0.5 | 2 }
  | { type: 'nudge'; ms: number }
  | { type: 'downbeat'; steps: number }
  | { type: 'key'; camelot: string | null }
  | { type: 'reset' };

/**
 * The analysis with the user's corrections applied, in the same shape, so everything downstream
 * reads it unchanged.
 *
 * - Tempo ×2 / ÷2 rescales `bpm` and the beat numbering (anchor beats scale too). A bar stays
 *   4 beats of the corrected tempo, so bars and phrases count twice as many (×2) or half as many
 *   (÷2) bars while phrases keep their place in time.
 * - The downbeat shift and grid offset move beat 0 (anchor times move with the offset). Beat 0
 *   is then re-chosen as the first downbeat at or after 0 s, and bars and phrases are re-indexed
 *   from it.
 * - Per-bar energies are re-binned onto the new bars (power average of the analysed bars each
 *   covers; bars outside the analysed span copy the nearest one). Bars are kept while they end
 *   within `duration` (or within the analysed bars when it is unknown), as the analyser does.
 *   Phrase boundaries snap to the nearest new bar line (ties go later); phrases still tile the
 *   bars from bar 0.
 * - A manual key replaces `key` with `source: 'manual'`; a moved downbeat counts as certain.
 */
export function applyOverrides<T extends AudioAnalysis>(
  analysis: T,
  overrides: AnalysisOverrides | undefined,
  duration?: number,
): T {
  if (!overrides) return analysis;
  const fixes = resolveOverrides(analysis, overrides);
  const key = fixes.key ? manualKey(fixes.key) : analysis.key;
  if (!isGridCorrected(fixes)) return fixes.key ? { ...analysis, key } : analysis;

  const { tempoMultiplier: multiplier, downbeatShift: shift } = fixes;
  const offset = fixes.gridOffsetMs / 1000;
  const period = 60 / analysis.bpm / multiplier;
  const source = analysisClock(analysis);

  // Corrected beat u sits on analysed beat `shift + u / multiplier`, moved by the offset.
  const moved = analysis.tempo.anchors?.map((a) => ({
    beat: (a.beat - shift) * multiplier,
    time: a.time + offset,
  }));
  const draft = gridClock(source.timeOf(shift) + offset, moved, period);
  const origin = BEATS_PER_BAR * Math.ceil(draft.beatAt(0) / BEATS_PER_BAR - 1e-9);
  const firstBeatTime = draft.timeOf(origin);
  const anchors = moved?.map((a) => ({ beat: a.beat - origin, time: a.time }));
  const clock = gridClock(firstBeatTime, anchors, period);

  const end = duration ?? source.timeOf(BEATS_PER_BAR * analysis.bars.lowDb.length);
  const bars = rebinBars(analysis.bars, source, clock, end);
  const phrases = remapPhrases(
    analysis.phrases,
    (bar) => clock.beatAt(source.timeOf(bar * BEATS_PER_BAR)) / BEATS_PER_BAR,
    bars.lowDb.length,
  );

  return {
    ...analysis,
    bpm: analysis.bpm * multiplier,
    firstBeatTime,
    downbeatConfidence: shift !== 0 ? 1 : analysis.downbeatConfidence,
    tempo: { ...analysis.tempo, anchors },
    bars,
    phrases,
    key,
  };
}

const effectiveCache = new WeakMap<
  AudioAnalysis,
  { overrides: AnalysisOverrides; duration: number; result: AudioAnalysis }
>();

/**
 * A track's analysis as the user corrected it (null until analysed). Use this instead of
 * `track.analysis` everywhere tempo, grid, phrases or key matter. The result is cached per
 * analysis and overrides object, so it stays referentially stable across renders.
 */
export function effectiveAnalysis<A extends AudioAnalysis>(track: {
  analysis: A | null;
  overrides?: AnalysisOverrides;
  duration: number;
}): A | null {
  const { analysis, overrides, duration } = track;
  if (!analysis || !overrides) return analysis;
  const hit = effectiveCache.get(analysis);
  if (hit && hit.overrides === overrides && hit.duration === duration) return hit.result as A;
  const result = applyOverrides(analysis, overrides, duration);
  effectiveCache.set(analysis, { overrides, duration, result });
  return result;
}

/**
 * Overrides with defaults filled in and stored values cleaned up. When the track has been
 * re-analysed since the grid corrections were made, they are re-expressed so the tempo octave
 * and the bar line the user placed stay where they were.
 */
export function resolveOverrides(
  analysis: AudioAnalysis,
  overrides: AnalysisOverrides | undefined,
): ResolvedOverrides {
  const own = normalize(overrides ?? {});
  const basis = overrides?.basis;
  if (!basis || !isGridCorrected(own) || !Number.isFinite(basis.downbeat) || sameGrid(basis, analysis)) {
    return own;
  }
  const tempoMultiplier =
    own.tempoMultiplier === 1 ? 1 : closestMultiplier((basis.bpm * own.tempoMultiplier) / analysis.bpm);
  const step = downbeatStep(tempoMultiplier);
  const clock = analysisClock(analysis);
  const downbeatShift = Math.round(clock.beatAt(basis.downbeat) / step) * step;
  // Without a nudge the new analysis's beat phase wins; with one, the user's ear does.
  const gridOffsetMs = own.gridOffsetMs === 0 ? 0 : (basis.downbeat - clock.timeOf(downbeatShift)) * 1000;
  return normalize({ tempoMultiplier, downbeatShift, gridOffsetMs, key: own.key });
}

/** Applies one deck-control edit; returns what to store on the track (undefined when nothing is left). */
export function editOverrides(
  analysis: AudioAnalysis,
  overrides: AnalysisOverrides | undefined,
  edit: OverrideEdit,
): AnalysisOverrides | undefined {
  if (edit.type === 'reset') return undefined;
  const next = { ...resolveOverrides(analysis, overrides) };
  switch (edit.type) {
    case 'tempo': {
      const multiplier = next.tempoMultiplier * edit.factor;
      if (MULTIPLIERS.includes(multiplier as TempoMultiplier)) next.tempoMultiplier = multiplier as TempoMultiplier;
      break;
    }
    case 'nudge':
      next.gridOffsetMs += edit.ms;
      break;
    case 'downbeat':
      next.downbeatShift += edit.steps * downbeatStep(next.tempoMultiplier);
      break;
    case 'key':
      next.key = edit.camelot;
      break;
  }
  return toStored(analysis, normalize(next));
}

/** True when the resolved overrides change anything. */
export function hasCorrections(fixes: ResolvedOverrides): boolean {
  return isGridCorrected(fixes) || fixes.key !== null;
}

/**
 * Analysed beats per downbeat step: one corrected beat, except after ÷2 where it is half of
 * one, so the user can also pick which half of the analysed beats are the real ones.
 */
export function downbeatStep(multiplier: TempoMultiplier): number {
  return Math.min(1, 1 / multiplier);
}

function isGridCorrected(fixes: ResolvedOverrides): boolean {
  return fixes.tempoMultiplier !== 1 || fixes.gridOffsetMs !== 0 || fixes.downbeatShift !== 0;
}

/** Snaps the shift to the step in use and wraps it to within half a bar (a whole bar is the same downbeat). */
function normalize(raw: {
  tempoMultiplier?: number;
  gridOffsetMs?: number;
  downbeatShift?: number;
  key?: string | null;
}): ResolvedOverrides {
  const tempoMultiplier = raw.tempoMultiplier === 0.5 || raw.tempoMultiplier === 2 ? raw.tempoMultiplier : 1;
  const step = downbeatStep(tempoMultiplier);
  const barBeats = BEATS_PER_BAR / tempoMultiplier;
  const snapped = Math.floor(finite(raw.downbeatShift) / step + 1e-9) * step;
  const key = raw.key ? fromCamelot(raw.key) : null;
  return {
    tempoMultiplier,
    gridOffsetMs: Math.round(finite(raw.gridOffsetMs) * 1000) / 1000 + 0,
    downbeatShift: snapped - barBeats * Math.round(snapped / barBeats) + 0,
    key: key && toCamelot(key),
  };
}

function toStored(analysis: AudioAnalysis, fixes: ResolvedOverrides): AnalysisOverrides | undefined {
  const stored: AnalysisOverrides = {};
  if (fixes.tempoMultiplier !== 1) stored.tempoMultiplier = fixes.tempoMultiplier;
  if (fixes.gridOffsetMs !== 0) stored.gridOffsetMs = fixes.gridOffsetMs;
  if (fixes.downbeatShift !== 0) stored.downbeatShift = fixes.downbeatShift;
  if (fixes.key) stored.key = fixes.key;
  if (isGridCorrected(fixes)) {
    stored.basis = {
      bpm: analysis.bpm,
      firstBeatTime: analysis.firstBeatTime,
      downbeat: analysisClock(analysis).timeOf(fixes.downbeatShift) + fixes.gridOffsetMs / 1000,
    };
  }
  return Object.keys(stored).length > 0 ? stored : undefined;
}

function manualKey(camelot: string): TrackKey {
  const key = fromCamelot(camelot)!;
  return { ...key, camelot: toCamelot(key), confidence: 1, source: 'manual' };
}

function sameGrid(basis: { bpm: number; firstBeatTime: number }, analysis: AudioAnalysis): boolean {
  return Math.abs(basis.bpm - analysis.bpm) < 1e-6 && Math.abs(basis.firstBeatTime - analysis.firstBeatTime) < 1e-6;
}

function closestMultiplier(ratio: number): TempoMultiplier {
  if (!(ratio > 0)) return 1;
  const distance = (m: number) => Math.abs(Math.log2(m) - Math.log2(ratio));
  return MULTIPLIERS.reduce((best, m) => (distance(m) < distance(best) ? m : best));
}

function finite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function analysisClock(analysis: AudioAnalysis): BeatClock {
  return gridClock(analysis.firstBeatTime, analysis.tempo.anchors, 60 / analysis.bpm);
}

/** Same choice as the analyser: anchors when the tempo drifts, else a straight grid. */
function gridClock(beatTime: number, anchors: GridAnchor[] | undefined, period: number): BeatClock {
  return anchors && anchors.length >= 2 ? anchoredClock(anchors, period) : constantClock(beatTime, period);
}

function rebinBars(bars: BarEnergies, source: BeatClock, clock: BeatClock, end: number): BarEnergies {
  const spans: [number, number][] = [];
  if (bars.lowDb.length > 0) {
    const analysedBar = (beat: number) => source.beatAt(clock.timeOf(beat)) / BEATS_PER_BAR;
    for (let bar = 0; clock.timeOf((bar + 1) * BEATS_PER_BAR) <= end + 1e-9; bar++) {
      spans.push([analysedBar(bar * BEATS_PER_BAR), analysedBar((bar + 1) * BEATS_PER_BAR)]);
    }
  }
  const rebin = (values: number[]) => spans.map(([from, to]) => powerAverage(values, from, to));
  return {
    lowDb: rebin(bars.lowDb),
    midDb: rebin(bars.midDb),
    highDb: rebin(bars.highDb),
    bassDb: rebin(bars.bassDb),
  };
}

/** Level (dB) over [from, to) in analysed bars, weighted by overlap; outside the bars, the nearest bar. */
function powerAverage(values: number[], from: number, to: number): number {
  const lo = Math.max(0, from);
  const hi = Math.min(values.length, to);
  if (hi - lo < 1e-9) return values[Math.min(values.length - 1, Math.max(0, Math.floor(from)))];
  let power = 0;
  for (let i = Math.floor(lo); i < hi; i++) {
    power += (Math.min(hi, i + 1) - Math.max(lo, i)) * Math.pow(10, values[i] / 10);
  }
  return Math.round(100 * Math.log10(power / (hi - lo))) / 10;
}

function remapPhrases(phrases: Phrase[], newBarOf: (bar: number) => number, barCount: number): Phrase[] {
  const starts = phrases.map((p) =>
    Math.min(barCount, Math.max(0, Math.floor(newBarOf(p.startBar) + 0.5 + 1e-9))),
  );
  const remapped: Phrase[] = [];
  phrases.forEach((phrase, i) => {
    const start = remapped.length === 0 ? 0 : starts[i];
    const end = i + 1 < phrases.length ? starts[i + 1] : barCount;
    if (end > start) remapped.push({ ...phrase, startBar: start, bars: end - start });
  });
  return remapped;
}
