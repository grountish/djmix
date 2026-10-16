import type { BeatClock } from './beatClock';
import { frameAt, type SpectralFeatures } from './spectrum';

/** How strongly claps/snares on beats 2 and 4 count against harmonic and energy cues. */
const BACKBEAT_WEIGHT = 1;
/** Beats compared on each side of a candidate bar line: short enough to pin the change down. */
const CHANGE_CONTEXT_BEATS = 2;

/**
 * Picks which beat of each group of four is the downbeat (phase = beat index mod 4). Chords
 * and arrangement change on bar lines; claps and snares land on beats 2 and 4.
 */
export function findDownbeatPhase(
  spectral: SpectralFeatures,
  clock: BeatClock,
  duration: number,
): { phase: number; confidence: number } {
  const firstBeat = Math.ceil(clock.beatAt(0) - 1e-9);
  const beats = Math.floor(clock.beatAt(duration)) - firstBeat;
  if (beats < 16) return { phase: 0, confidence: 0 };

  const chroma: Float64Array[] = [];
  const bands = [new Float64Array(beats), new Float64Array(beats), new Float64Array(beats)];
  const clap = new Float64Array(beats);

  for (let i = 0; i < beats; i++) {
    const start = frameAt(spectral, clock.timeOf(firstBeat + i));
    const end = Math.max(start + 1, frameAt(spectral, clock.timeOf(firstBeat + i + 1)));
    const vector = new Float64Array(12);
    const power = [0, 0, 0];
    let count = 0;
    for (let f = start; f < end && f < spectral.frames; f++) {
      for (let pc = 0; pc < 12; pc++) vector[pc] += spectral.chroma[f * 12 + pc];
      power[0] += spectral.lowPower[f];
      power[1] += spectral.midPower[f];
      power[2] += spectral.highPower[f];
      count++;
    }
    chroma.push(vector);
    power.forEach((p, band) => (bands[band][i] = Math.log10(p / Math.max(1, count) + 1e-12)));

    let peak = 0;
    for (let f = Math.max(0, start - 1); f <= start + 1 && f < spectral.frames; f++) {
      peak = Math.max(peak, spectral.fluxMid[f]);
    }
    clap[i] = peak;
  }

  const context = CHANGE_CONTEXT_BEATS;
  const harmonic = new Float64Array(beats);
  const level = new Float64Array(beats);
  for (let i = context; i + context <= beats; i++) {
    harmonic[i] = 1 - cosine(sumVectors(chroma, i - context, i), sumVectors(chroma, i, i + context));
    for (const band of bands) {
      level[i] += Math.abs(mean(band, i, i + context) - mean(band, i - context, i));
    }
  }

  const change = add(zScore(harmonic, context, beats - context), zScore(level, context, beats - context));
  const backbeat = zScore(clap, 0, beats);

  const scores = [0, 1, 2, 3].map((phase) => {
    let changeSum = 0;
    let changeCount = 0;
    let backbeatSum = 0;
    for (let i = 0; i < beats; i++) {
      const position = (((firstBeat + i - phase) % 4) + 4) % 4;
      if (position === 0 && i >= context && i + context <= beats) {
        changeSum += change[i];
        changeCount++;
      }
      backbeatSum += position % 2 === 1 ? backbeat[i] : -backbeat[i];
    }
    return changeSum / Math.max(1, changeCount) + (BACKBEAT_WEIGHT * backbeatSum) / beats;
  });

  const order = [0, 1, 2, 3].sort((a, b) => scores[b] - scores[a]);
  const best = scores[order[0]];
  const second = scores[order[1]];
  return {
    phase: order[0],
    confidence: Math.max(0, Math.min(1, (best - second) / (Math.abs(best) + Math.abs(second) + 1e-9))),
  };
}

function sumVectors(vectors: Float64Array[], from: number, to: number): Float64Array {
  const sum = new Float64Array(12);
  for (let k = from; k < to; k++) for (let pc = 0; pc < 12; pc++) sum[pc] += vectors[k][pc];
  return sum;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 1;
}

function mean(x: Float64Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i];
  return sum / Math.max(1, to - from);
}

/** z-score over [from, to); values outside the range become 0. */
function zScore(x: Float64Array, from: number, to: number): Float64Array {
  const m = mean(x, from, to);
  let variance = 0;
  for (let i = from; i < to; i++) variance += (x[i] - m) ** 2;
  const sd = Math.sqrt(variance / Math.max(1, to - from)) || 1;
  const out = new Float64Array(x.length);
  for (let i = from; i < to; i++) out[i] = (x[i] - m) / sd;
  return out;
}

function add(a: Float64Array, b: Float64Array): Float64Array {
  return a.map((v, i) => v + b[i]);
}
