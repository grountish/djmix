import type { BeatClock } from './beatClock';
import { percentile, powerToDb } from './dsp';
import { frameAt, frameTime, type SpectralFeatures } from './spectrum';
import type { BarEnergies, Phrase, PhraseLabel } from './types';

const BEATS_PER_BAR = 4;
const PHRASE_BARS = 8;
/** Novelty compared over these context lengths (bars) on each side of a bar line. */
const NOVELTY_SCALES = [4, 8];
/** Beat-phase range treated as "between kicks" when measuring the bassline. */
const BASS_PHASE: [number, number] = [0.35, 0.95];
/** A bar has a bassline when its between-kick low end is within this of the track's loudest. */
const BASS_PRESENT_DB = 8;
/** Kick flux on the beats must exceed the bar's average kick flux by this factor… */
const KICK_BEAT_RATIO = 3;
/** …and reach this share of the track's typical kick, so near-silence doesn't count. */
const KICK_LEVEL_RATIO = 0.1;
/** A bar is "loud" within this of the track's loud bars. */
const LOUD_DB = 6;

interface BarFeatures {
  energies: BarEnergies;
  totalDb: number[];
  fluxDb: number[];
  /** Mean kick flux on the beats. */
  kick: number[];
  /** Beat kick flux relative to the bar's average kick flux. */
  kickRatio: number[];
  chroma: Float64Array[];
}

interface BlockState {
  kick: boolean;
  bass: boolean;
  loud: boolean;
}

/**
 * Bar energies plus phrase sections. Each bar is classified (kick, bassline, loudness), the
 * classification is taken by majority over the 8-bar phrase grid, and runs of equal blocks
 * become sections labelled by where they sit around the full-energy parts.
 */
export function analyzeStructure(
  spectral: SpectralFeatures,
  clock: BeatClock,
  downbeat: number,
  duration: number,
): { bars: BarEnergies; phrases: Phrase[] } {
  let barCount = 0;
  while (clock.timeOf(downbeat + (barCount + 1) * BEATS_PER_BAR) <= duration) barCount++;
  const features = measureBars(spectral, clock, downbeat, barCount);
  if (barCount < 2) return { bars: features.energies, phrases: [] };

  const origin = choosePhraseOrigin(computeNovelty(features, barCount));
  const starts = [0];
  for (let bar = origin; bar < barCount; bar += PHRASE_BARS) if (bar > 0) starts.push(bar);

  const flags = classifyBars(features);
  const blocks = starts.map((start, i) => {
    const end = starts[i + 1] ?? barCount;
    const majority = (key: keyof BlockState) => {
      let count = 0;
      for (let bar = start; bar < end; bar++) if (flags[bar][key]) count++;
      return count * 2 >= end - start;
    };
    return { start, end, state: { kick: majority('kick'), bass: majority('bass'), loud: majority('loud') } };
  });

  return { bars: features.energies, phrases: labelBlocks(features, blocks) };
}

function measureBars(
  spectral: SpectralFeatures,
  clock: BeatClock,
  downbeat: number,
  barCount: number,
): BarFeatures {
  const energies: BarEnergies = { lowDb: [], midDb: [], highDb: [], bassDb: [] };
  const features: BarFeatures = { energies, totalDb: [], fluxDb: [], kick: [], kickRatio: [], chroma: [] };

  for (let b = 0; b < barCount; b++) {
    const firstBeat = downbeat + b * BEATS_PER_BAR;
    const firstFrame = frameAt(spectral, clock.timeOf(firstBeat));
    const lastFrame = Math.min(spectral.frames, frameAt(spectral, clock.timeOf(firstBeat + BEATS_PER_BAR)));
    const frames = Math.max(1, lastFrame - firstFrame);
    let low = 0;
    let mid = 0;
    let high = 0;
    let bass = 0;
    let bassFrames = 0;
    let flux = 0;
    let kickFlux = 0;
    const vector = new Float64Array(12);

    for (let f = firstFrame; f < lastFrame; f++) {
      low += spectral.lowPower[f];
      mid += spectral.midPower[f];
      high += spectral.highPower[f];
      flux += spectral.flux[f];
      kickFlux += spectral.fluxLow[f];
      for (let pc = 0; pc < 12; pc++) vector[pc] += spectral.chroma[f * 12 + pc];
      const beatPosition = clock.beatAt(frameTime(spectral, f));
      const beatPhase = beatPosition - Math.floor(beatPosition);
      if (beatPhase >= BASS_PHASE[0] && beatPhase < BASS_PHASE[1]) {
        bass += spectral.lowPower[f];
        bassFrames++;
      }
    }

    let kickSum = 0;
    for (let beat = 0; beat < BEATS_PER_BAR; beat++) {
      const f = frameAt(spectral, clock.timeOf(firstBeat + beat));
      let peak = 0;
      for (let g = Math.max(0, f - 1); g <= f + 1 && g < spectral.frames; g++) {
        peak = Math.max(peak, spectral.fluxLow[g]);
      }
      kickSum += peak;
    }

    energies.lowDb.push(round1(powerToDb(low / frames)));
    energies.midDb.push(round1(powerToDb(mid / frames)));
    energies.highDb.push(round1(powerToDb(high / frames)));
    energies.bassDb.push(round1(powerToDb(bass / Math.max(1, bassFrames))));
    features.totalDb.push(powerToDb((low + mid + high) / frames));
    features.fluxDb.push(Math.log1p(flux / frames));
    features.kick.push(kickSum / BEATS_PER_BAR);
    features.kickRatio.push(kickSum / BEATS_PER_BAR / (kickFlux / frames + 1e-9));
    features.chroma.push(vector);
  }
  return features;
}

function classifyBars(features: BarFeatures): BlockState[] {
  const loudRef = percentile(features.totalDb, 90);
  const bassRef = percentile(features.energies.bassDb, 90);
  const kickRef = percentile(features.kick, 90) || 1;
  return features.totalDb.map((totalDb, bar) => ({
    kick: features.kickRatio[bar] >= KICK_BEAT_RATIO && features.kick[bar] >= KICK_LEVEL_RATIO * kickRef,
    bass: features.energies.bassDb[bar] >= bassRef - BASS_PRESENT_DB,
    loud: totalDb >= loudRef - LOUD_DB,
  }));
}

/** Change between the bars before and after each bar line, over several context lengths. */
function computeNovelty(features: BarFeatures, barCount: number): number[] {
  const columns = [
    features.energies.lowDb,
    features.energies.midDb,
    features.energies.highDb,
    features.energies.bassDb,
    features.fluxDb,
  ].map(standardize);

  const novelty = new Array<number>(barCount).fill(0);
  for (let bar = 1; bar < barCount; bar++) {
    for (const scale of NOVELTY_SCALES) {
      const before = Math.max(0, bar - scale);
      const after = Math.min(barCount, bar + scale);
      let distance = 0;
      for (const column of columns) {
        distance += (average(column, bar, after) - average(column, before, bar)) ** 2;
      }
      const harmonic =
        1 - cosine(sumChroma(features.chroma, before, bar), sumChroma(features.chroma, bar, after));
      novelty[bar] += Math.sqrt(distance) + 2 * harmonic;
    }
  }
  return novelty;
}

/** Offset of the 8-bar phrase grid that lines up best with the changes. */
function choosePhraseOrigin(novelty: number[]): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let origin = 0; origin < PHRASE_BARS; origin++) {
    let score = 0;
    for (let bar = origin; bar < novelty.length; bar += PHRASE_BARS) score += novelty[bar];
    if (score > bestScore) {
      bestScore = score;
      best = origin;
    }
  }
  return best;
}

function labelBlocks(
  features: BarFeatures,
  blocks: { start: number; end: number; state: BlockState }[],
): Phrase[] {
  // Runs of blocks with the same state form one section.
  const sections: { start: number; end: number; state: BlockState }[] = [];
  for (const block of blocks) {
    const previous = sections[sections.length - 1];
    const same =
      previous &&
      previous.state.kick === block.state.kick &&
      previous.state.bass === block.state.bass &&
      previous.state.loud === block.state.loud;
    if (same) previous.end = block.end;
    else sections.push({ ...block, state: { ...block.state } });
  }

  const fullBy = (test: (s: BlockState) => boolean) => sections.map((s) => test(s.state));
  let isFull = fullBy((s) => s.kick && s.bass && s.loud);
  if (!isFull.some(Boolean)) isFull = fullBy((s) => s.kick && s.loud);
  if (!isFull.some(Boolean)) isFull = fullBy((s) => s.loud);
  const firstFull = isFull.indexOf(true);
  const lastFull = isFull.lastIndexOf(true);

  return sections.map((section, i): Phrase => {
    const bars = section.end - section.start;
    let label: PhraseLabel;
    if (isFull[i]) label = 'drop';
    else if (i < firstFull) label = 'intro';
    else if (i > lastFull) label = 'outro';
    else {
      const half = section.start + Math.floor(bars / 2);
      const risingHighs =
        bars >= 2 &&
        average(features.energies.highDb, half, section.end) >
          average(features.energies.highDb, section.start, half) + 2;
      label = isFull[i + 1] && risingHighs ? 'build' : 'breakdown';
    }
    return {
      startBar: section.start,
      bars,
      label,
      hasKick: section.state.kick,
      hasBass: section.state.bass,
      energyDb: round1(average(features.totalDb, section.start, section.end)),
    };
  });
}

function standardize(values: number[]): number[] {
  const m = average(values, 0, values.length);
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, values.length)) || 1;
  return values.map((v) => (v - m) / sd);
}

function average(values: number[], from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i];
  return sum / Math.max(1, to - from);
}

function sumChroma(vectors: Float64Array[], from: number, to: number): Float64Array {
  const sum = new Float64Array(12);
  for (let i = from; i < to; i++) for (let pc = 0; pc < 12; pc++) sum[pc] += vectors[i][pc];
  return sum;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 12; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 1;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
