import { anchoredClock } from './beatClock';
import { BUTTERWORTH4_Q, filtfilt, lowpass, median, parabolicOffset } from './dsp';
import type { SpectralFeatures } from './spectrum';
import type { GridAnchor } from './types';

export interface BeatGridFit {
  bpm: number;
  /** Seconds per beat. */
  period: number;
  /** Time of one beat in [0, period); beat k sits at beatTime + k · period. */
  beatTime: number;
  isConstant: boolean;
  residualMs: number;
  /** Share of the track where kicks lock clearly onto the grid. */
  coverage: number;
  anchors?: GridAnchor[];
}

/** Fine period search: ±2% around the estimate, coarse then fine steps (in BPM). */
const PERIOD_SEARCH = 0.02;
const COARSE_STEP_BPM = 0.02;
const FINE_STEP_BPM = 0.001;
const FOLD_BINS = 48;

const KICK_CUTOFF_HZ = 150;
/** Centre of the quadrature pair used to remove envelope ripple from low-band tones. */
const KICK_ENVELOPE_HZ = 80;
/** Kick envelope resolution, samples per second (0.5 ms). */
const KICK_ENVELOPE_RATE = 2000;
const KICK_ENVELOPE_SMOOTHING = 0.004;

/** Beats averaged per measurement window, and the hop between windows. */
const WINDOW_BEATS = 16;
const WINDOW_HOP_BEATS = 8;
/** Correlation with the track's average kick a window needs to count as a measurement. */
const MIN_WINDOW_CORRELATION = 0.6;
/** Peak-to-floor ratio of a window's averaged envelope: rejects windows without kicks. */
const MIN_WINDOW_PUNCH = 1.5;
/** Search range once the grid is close. */
const REFINE_SEARCH = 0.03;
const MIN_OUTLIER_LIMIT = 0.004;
const CONSTANT_TEMPO_MAX_RESIDUAL_MS = 3;
/**
 * Kicks this far off the straight grid in consecutive windows are a real local shift (an edit,
 * a re-recorded section), not noise: the robust fit would drop them as outliers, so they are
 * checked separately and turn the grid into measured anchors.
 */
const LOCAL_SHIFT_MS = 4;
const LOCAL_SHIFT_WINDOWS = 2;

interface WindowMeasurement {
  /** Centre beat index. */
  beat: number;
  /** Lag of this window's kicks against the track's average kick, seconds. */
  offset: number;
  weight: number;
}

interface KickEnvelope {
  values: Float32Array;
  /** Value j describes time (j + 0.5) / rate. */
  rate: number;
}

/**
 * Fits a beat grid precise to well under a millisecond: the tempo estimate is refined by
 * folding onsets over the whole track, kick lags measured over 4-bar windows are regressed
 * against beat index to correct the period, and the track's average kick sets the phase.
 */
export function fitBeatGrid(
  mono: Float32Array,
  sampleRate: number,
  spectral: SpectralFeatures,
  bpmEstimate: number,
): BeatGridFit {
  const duration = mono.length / sampleRate;
  const frameRate = spectral.sampleRate / spectral.hop;
  const foldOnset = combineOnsets(spectral.fluxLow, spectral.flux);

  let { bpm, phase } = searchPeriod(foldOnset, frameRate, bpmEstimate);
  let period = 60 / bpm;
  let beatTime = phase * period;

  const envelope = kickEnvelope(mono, sampleRate);
  const lastBeat = () => Math.floor((duration - beatTime) / period) - 1;

  let windows: WindowMeasurement[] = [];
  let fit: LineFit | null = null;
  for (let pass = 0; pass < 4; pass++) {
    const template = averageKick(envelope, gridBeats(beatTime, period, 0, lastBeat()), period);
    const search = pass === 0 ? period / 4 : REFINE_SEARCH;
    windows = measureGridWindows(envelope, template, beatTime, period, lastBeat(), search);
    fit = fitRobustLine(windows);
    if (!fit) break;
    beatTime += fit.intercept - fit.slope * fit.beatMean;
    period += fit.slope;
  }

  beatTime += kickOnset(averageKick(envelope, gridBeats(beatTime, period, 0, lastBeat()), period));
  bpm = 60 / period;
  beatTime = ((beatTime % period) + period) % period;

  const accepted = fit?.accepted ?? [];
  const residualMs = fit ? fit.rmsResidual * 1000 : 0;
  const isConstant =
    residualMs <= CONSTANT_TEMPO_MAX_RESIDUAL_MS && (!fit || !hasLocalShift(windows, fit));
  const coverage = windows.length ? accepted.length / windows.length : 0;

  return {
    bpm,
    period,
    beatTime,
    isConstant,
    residualMs,
    coverage,
    anchors: isConstant ? undefined : trackAnchors(envelope, beatTime, period, lastBeat()),
  };
}

/** Normalised kick flux plus a little broadband flux, for tracks with soft kicks. */
function combineOnsets(kick: Float32Array, broadband: Float32Array): Float32Array {
  const mean = (x: Float32Array) => x.reduce((s, v) => s + v, 0) / x.length || 1;
  const kickMean = mean(kick);
  const broadMean = mean(broadband);
  const out = new Float32Array(kick.length);
  for (let i = 0; i < out.length; i++) out[i] = kick[i] / kickMean + (0.5 * broadband[i]) / broadMean;
  return out;
}

function searchPeriod(
  onset: Float32Array,
  frameRate: number,
  bpmEstimate: number,
): { bpm: number; phase: number } {
  const bins = new Float64Array(FOLD_BINS);
  const scan = (from: number, to: number, step: number) => {
    let best = { bpm: bpmEstimate, phase: 0, score: -Infinity };
    for (let bpm = from; bpm <= to; bpm += step) {
      const fold = foldOnsets(onset, (60 * frameRate) / bpm, bins);
      if (fold.score > best.score) best = { bpm, ...fold };
    }
    return best;
  };

  const coarse = scan(
    bpmEstimate * (1 - PERIOD_SEARCH),
    bpmEstimate * (1 + PERIOD_SEARCH),
    COARSE_STEP_BPM,
  );
  const fine = scan(coarse.bpm - COARSE_STEP_BPM, coarse.bpm + COARSE_STEP_BPM, FINE_STEP_BPM);
  return { bpm: fine.bpm, phase: fine.phase };
}

/** Wraps the onset curve around one beat period; a sharp peak means the period fits. */
function foldOnsets(
  onset: Float32Array,
  periodFrames: number,
  bins: Float64Array,
): { score: number; phase: number } {
  const n = bins.length;
  bins.fill(0);
  let total = 0;
  for (let i = 0; i < onset.length; i++) {
    const value = onset[i];
    if (value === 0) continue;
    const position = ((i / periodFrames) % 1) * n;
    const bin = Math.floor(position);
    const frac = position - bin;
    bins[bin % n] += value * (1 - frac);
    bins[(bin + 1) % n] += value * frac;
    total += value;
  }

  let peak = 0;
  let peakValue = -Infinity;
  const smoothed = (b: number) => bins[(b - 1 + n) % n] + 2 * bins[b] + bins[(b + 1) % n];
  for (let b = 0; b < n; b++) {
    const value = smoothed(b);
    if (value > peakValue) {
      peakValue = value;
      peak = b;
    }
  }
  const offset = parabolicOffset(smoothed((peak - 1 + n) % n), peakValue, smoothed((peak + 1) % n));
  return {
    score: total > 0 ? peakValue / ((4 * total) / n) : 0,
    phase: (((peak + offset) / n) % 1 + 1) % 1,
  };
}

/**
 * Low-band energy envelope. Zero-phase filtering adds no delay, and the quadrature term
 * (x'/ω)² cancels the ripple a low tone leaves in x², so kicks become clean bumps.
 */
function kickEnvelope(mono: Float32Array, sampleRate: number): KickEnvelope {
  const low = filtfilt(
    mono,
    BUTTERWORTH4_Q.map((q) => lowpass(KICK_CUTOFF_HZ, sampleRate, q)),
  );
  const hop = Math.max(1, Math.round(sampleRate / KICK_ENVELOPE_RATE));
  const blocks = Math.floor(low.length / hop);
  const derivativeScale = sampleRate / 2 / (2 * Math.PI * KICK_ENVELOPE_HZ);

  const energy = new Float64Array(blocks);
  for (let j = 0; j < blocks; j++) {
    let sum = 0;
    for (let i = Math.max(1, j * hop); i < Math.min(low.length - 1, (j + 1) * hop); i++) {
      const quadrature = (low[i + 1] - low[i - 1]) * derivativeScale;
      sum += low[i] * low[i] + quadrature * quadrature;
    }
    energy[j] = sum / hop;
  }

  // Centred boxcar: a step's 50% point stays where the step is.
  const radius = Math.max(1, Math.round((KICK_ENVELOPE_SMOOTHING * KICK_ENVELOPE_RATE) / 2));
  const values = new Float32Array(blocks);
  let sum = 0;
  for (let j = 0; j < Math.min(blocks, radius); j++) sum += energy[j];
  for (let j = 0; j < blocks; j++) {
    if (j + radius < blocks) sum += energy[j + radius];
    if (j - radius - 1 >= 0) sum -= energy[j - radius - 1];
    const count = Math.min(blocks - 1, j + radius) - Math.max(0, j - radius) + 1;
    values[j] = sum / count;
  }
  return { values, rate: sampleRate / hop };
}

function envelopeAt(envelope: KickEnvelope, time: number): number {
  const position = time * envelope.rate - 0.5;
  const i = Math.floor(position);
  if (i < 0 || i + 1 >= envelope.values.length) return 0;
  const frac = position - i;
  return envelope.values[i] * (1 - frac) + envelope.values[i + 1] * frac;
}

/** Adds the envelope around `centre` (±half samples) into `out`. */
function addAround(envelope: KickEnvelope, centre: number, half: number, out: Float64Array): void {
  for (let s = -half; s <= half; s++) out[s + half] += envelopeAt(envelope, centre + s / envelope.rate);
}

/** The track's average kick: envelope averaged over the given beats, ±half a beat. */
function averageKick(envelope: KickEnvelope, beatTimes: number[], period: number): Float64Array {
  const half = Math.round((period / 2) * envelope.rate);
  const values = new Float64Array(2 * half + 1);
  for (const time of beatTimes) addAround(envelope, time, half, values);
  return values.map((v) => v / Math.max(1, beatTimes.length));
}

function gridBeats(beatTime: number, period: number, from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => beatTime + (from + i) * period);
}

/** Where the average kick crosses halfway from its floor to its peak, relative to the beat. */
function kickOnset(template: Float64Array): number {
  const half = (template.length - 1) / 2;
  const reach = Math.max(2, Math.round(half / 4));
  let peak = half;
  for (let i = half - reach; i <= half + reach; i++) if (template[i] > template[peak]) peak = i;
  let floor = template[peak];
  for (let i = Math.max(0, peak - 2 * reach); i <= peak; i++) floor = Math.min(floor, template[i]);
  if (template[peak] <= floor * MIN_WINDOW_PUNCH) return 0;

  const level = floor + 0.5 * (template[peak] - floor);
  for (let i = peak; i > 0; i--) {
    if (template[i - 1] < level) {
      const frac = (level - template[i - 1]) / (template[i] - template[i - 1]);
      return (i - 1 + frac - half) / KICK_ENVELOPE_RATE;
    }
  }
  return 0;
}

/**
 * Lag of a window's averaged kicks against the track's average kick (normalised
 * cross-correlation over ±a quarter beat around the beat).
 */
function measureWindow(
  envelope: KickEnvelope,
  template: Float64Array,
  predicted: number[],
  search: number,
): { offset: number; weight: number } {
  const templateHalf = (template.length - 1) / 2;
  const segment = Math.max(2, Math.round(templateHalf / 2));
  const reach = Math.max(2, Math.round(search * envelope.rate));
  const windowHalf = segment + reach;

  const average = new Float64Array(2 * windowHalf + 1);
  for (const time of predicted) addAround(envelope, time, windowHalf, average);

  const length = 2 * segment + 1;
  const reference = template.subarray(templateHalf - segment, templateHalf + segment + 1);
  const referenceMean = reference.reduce((s, v) => s + v, 0) / length;
  let referenceNorm = 0;
  for (const v of reference) referenceNorm += (v - referenceMean) ** 2;
  referenceNorm = Math.sqrt(referenceNorm);

  const correlations = new Float64Array(2 * reach + 1);
  for (let lag = -reach; lag <= reach; lag++) {
    const start = reach + lag;
    let sum = 0;
    let sumSquares = 0;
    let dot = 0;
    for (let i = 0; i < length; i++) {
      const w = average[start + i];
      sum += w;
      sumSquares += w * w;
      dot += (reference[i] - referenceMean) * w;
    }
    const spread = Math.sqrt(Math.max(0, sumSquares - (sum * sum) / length));
    correlations[lag + reach] = referenceNorm > 0 && spread > 0 ? dot / (referenceNorm * spread) : 0;
  }

  let best = 0;
  for (let i = 1; i < correlations.length; i++) if (correlations[i] > correlations[best]) best = i;
  const refined =
    best > 0 && best < correlations.length - 1
      ? best + parabolicOffset(correlations[best - 1], correlations[best], correlations[best + 1])
      : best;

  // Windows without kicks (breakdowns) correlate by chance; require a real bump too.
  const central = average.subarray(windowHalf - segment / 2, windowHalf + segment / 2 + 1);
  const punch = Math.max(...central) / (median(average) + 1e-12);
  const correlation = correlations[best];
  return {
    offset: (refined - reach) / envelope.rate,
    weight: correlation >= MIN_WINDOW_CORRELATION && punch >= MIN_WINDOW_PUNCH ? correlation : 0,
  };
}

function measureGridWindows(
  envelope: KickEnvelope,
  template: Float64Array,
  beatTime: number,
  period: number,
  lastBeat: number,
  search: number,
): WindowMeasurement[] {
  const windows: WindowMeasurement[] = [];
  for (let first = 0; first + WINDOW_BEATS - 1 <= lastBeat; first += WINDOW_HOP_BEATS) {
    const predicted = Array.from({ length: WINDOW_BEATS }, (_, i) => beatTime + (first + i) * period);
    const { offset, weight } = measureWindow(envelope, template, predicted, search);
    windows.push({ beat: first + (WINDOW_BEATS - 1) / 2, offset, weight });
  }
  return windows;
}

/** True when consecutive measured windows sit off the fitted line by more than LOCAL_SHIFT_MS. */
function hasLocalShift(windows: WindowMeasurement[], fit: LineFit): boolean {
  let run = 0;
  for (const w of windows) {
    if (w.weight === 0) continue;
    const residual = w.offset - (fit.intercept + fit.slope * (w.beat - fit.beatMean));
    run = Math.abs(residual) * 1000 > LOCAL_SHIFT_MS ? run + 1 : 0;
    if (run >= LOCAL_SHIFT_WINDOWS) return true;
  }
  return false;
}

interface LineFit {
  /** Offset at `beatMean`. */
  intercept: number;
  /** Offset change per beat (period correction). */
  slope: number;
  beatMean: number;
  rmsResidual: number;
  accepted: WindowMeasurement[];
}

/** Weighted least squares of offset against beat, dropping outliers. */
function fitRobustLine(windows: WindowMeasurement[]): LineFit | null {
  let accepted = windows.filter((w) => w.weight > 0);
  let fit: LineFit | null = null;

  for (let round = 0; round < 3; round++) {
    if (accepted.length < 3) return fit;
    const totalWeight = accepted.reduce((s, w) => s + w.weight, 0);
    const beatMean = accepted.reduce((s, w) => s + w.weight * w.beat, 0) / totalWeight;
    const offsetMean = accepted.reduce((s, w) => s + w.weight * w.offset, 0) / totalWeight;
    let sxy = 0;
    let sxx = 0;
    for (const w of accepted) {
      sxy += w.weight * (w.beat - beatMean) * (w.offset - offsetMean);
      sxx += w.weight * (w.beat - beatMean) ** 2;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const residual = (w: WindowMeasurement) => w.offset - (offsetMean + slope * (w.beat - beatMean));
    const rms = Math.sqrt(accepted.reduce((s, w) => s + w.weight * residual(w) ** 2, 0) / totalWeight);
    fit = { intercept: offsetMean, slope, beatMean, rmsResidual: rms, accepted };

    const spread = 1.4826 * median(accepted.map((w) => Math.abs(residual(w))));
    const limit = Math.max(MIN_OUTLIER_LIMIT, 3 * spread);
    const kept = accepted.filter((w) => Math.abs(residual(w)) <= limit);
    if (kept.length === accepted.length) break;
    accepted = kept;
  }
  return fit;
}

/** Beats per coarse tracking window: short, so drift inside one window stays small. */
const COARSE_WINDOW_BEATS = 4;
/** Beats of a coarse window that must each show the kick, so a pad swell can't pass. */
const COARSE_MIN_KICKS = 3;
/** Measurements used to extrapolate drift. */
const DRIFT_HISTORY = 6;
/** A kick-less stretch longer than this splits tracking into separate segments. */
const MAX_GAP_BEATS = 16;
/** Shorter segments are isolated hits (a pad swell in a breakdown) and are dropped. */
const MIN_SEGMENT_WINDOWS = 3;
/** Anchor windows: short with a small hop, so anchors sit close to where kicks return. */
const ANCHOR_WINDOW_BEATS = 8;
const ANCHOR_HOP_BEATS = 4;

interface DriftPoint {
  beat: number;
  /** Kick position minus the straight-grid beat position, seconds. */
  offset: number;
}

/**
 * For drifting tempo: measured beat positions, one per window. Kicks are first located
 * template-free (peak of the envelope averaged over 4 beats, within half a beat of the straight
 * grid) and unwrapped against the recent drift. Long kick-less stretches split the track into
 * segments, joined by extrapolating both sides to the middle of the gap so beat indices stay
 * consistent. Every window is then re-measured against a sharp average kick built on the
 * measured positions.
 */
function trackAnchors(
  envelope: KickEnvelope,
  beatTime: number,
  period: number,
  lastBeat: number,
): GridAnchor[] {
  const segments = joinSegments(trackSegments(envelope, beatTime, period, lastBeat), period);
  const coarse = segments.flat().map((p) => ({ beat: p.beat, time: beatTime + p.beat * period + p.offset }));
  if (coarse.length < 2) return coarse;

  // Re-measure against an average kick built on the current positions; the second round
  // starts from sharper positions, so its template is sharper too.
  let anchors: GridAnchor[] = coarse;
  for (let round = 0; round < 2 && anchors.length >= 2; round++) {
    const clock = anchoredClock(anchors, period);
    const aligned = averageKick(
      envelope,
      Array.from({ length: lastBeat + 1 }, (_, k) => clock.timeOf(k)),
      period,
    );
    const onset = kickOnset(aligned);
    const refined: GridAnchor[] = [];
    for (let first = 0; first + ANCHOR_WINDOW_BEATS - 1 <= lastBeat; first += ANCHOR_HOP_BEATS) {
      const predicted = Array.from({ length: ANCHOR_WINDOW_BEATS }, (_, i) => clock.timeOf(first + i));
      const { offset, weight } = measureWindow(envelope, aligned, predicted, period / 8);
      if (weight === 0) continue;
      const centre = first + (ANCHOR_WINDOW_BEATS - 1) / 2;
      refined.push({ beat: centre, time: clock.timeOf(centre) + offset + onset });
    }
    anchors = refined;
  }
  return anchors;
}

/** Template-free kick offsets per 4-beat window, unwrapped into continuous segments. */
function trackSegments(
  envelope: KickEnvelope,
  beatTime: number,
  period: number,
  lastBeat: number,
): DriftPoint[][] {
  const half = Math.round((period / 2) * envelope.rate);
  const segments: DriftPoint[][] = [];
  let current: DriftPoint[] = [];

  for (let first = 0; first + COARSE_WINDOW_BEATS - 1 <= lastBeat; first += COARSE_WINDOW_BEATS) {
    const beats = Array.from({ length: COARSE_WINDOW_BEATS }, (_, i) => {
      const segment = new Float64Array(2 * half + 1);
      addAround(envelope, beatTime + (first + i) * period, half, segment);
      return segment;
    });
    const average = beats.reduce((sum, segment) => sum.map((v, i) => v + segment[i]));
    let peak = 0;
    for (let i = 1; i < average.length; i++) if (average[i] > average[peak]) peak = i;
    const kicks = beats.filter((segment) => segment[peak] >= MIN_WINDOW_PUNCH * (median(segment) + 1e-12));
    if (kicks.length < COARSE_MIN_KICKS) continue;

    const beat = first + (COARSE_WINDOW_BEATS - 1) / 2;
    const offset = (peak - half) / envelope.rate;
    const previous = current[current.length - 1];
    if (previous && beat - previous.beat > MAX_GAP_BEATS) {
      segments.push(current);
      current = [];
    }
    const expected = extrapolateDrift(current.slice(-DRIFT_HISTORY), beat);
    const unwrapped = expected === null ? offset : offset + period * Math.round((expected - offset) / period);
    if (expected !== null && current.length >= 3 && Math.abs(unwrapped - expected) > period / 4) continue;
    current.push({ beat, offset: unwrapped });
  }
  if (current.length > 0) segments.push(current);
  return segments.filter((segment) => segment.length >= MIN_SEGMENT_WINDOWS);
}

/** Shifts each segment by whole beats so it meets the previous one in the middle of the gap. */
function joinSegments(segments: DriftPoint[][], period: number): DriftPoint[][] {
  const joined: DriftPoint[][] = [];
  for (const segment of segments) {
    const previous = joined[joined.length - 1];
    if (!previous) {
      joined.push(segment);
      continue;
    }
    const tail = previous.slice(-DRIFT_HISTORY);
    const head = segment.slice(0, DRIFT_HISTORY);
    const middle = (tail[tail.length - 1].beat + head[0].beat) / 2;
    const fromBefore = extrapolateDrift(tail, middle) ?? 0;
    const fromAfter = extrapolateDrift([...head].reverse(), middle) ?? 0;
    const shift = period * Math.round((fromBefore - fromAfter) / period);
    joined.push(segment.map((p) => ({ beat: p.beat, offset: p.offset + shift })));
  }
  return joined;
}

/**
 * Offset expected at `beat`, continuing from the last point at the median pairwise slope;
 * null without history.
 */
function extrapolateDrift(points: DriftPoint[], beat: number): number | null {
  if (points.length === 0) return null;
  const last = points[points.length - 1];
  if (points.length === 1) return last.offset;
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      slopes.push((points[j].offset - points[i].offset) / (points[j].beat - points[i].beat));
    }
  }
  return last.offset + median(slopes) * (beat - last.beat);
}
