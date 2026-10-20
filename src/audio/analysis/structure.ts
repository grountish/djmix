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
/**
 * A bar this far below the track's loud bars is near-silence or the bottom of a fade: a change
 * whose context reaches into such bars is the fade, not a section boundary.
 */
const AUDIBLE_DB = 20;
/**
 * Cost of a phrase that isn't 8 bars long, against the gain of the boundaries it lets the grid
 * reach (each boundary's change squared, relative to the track's strongest few). A 4-bar
 * break inserted in a run of 8-bar phrases is the common case; other lengths cost more.
 */
const IRREGULAR_PHRASE_COST = 1.5;
/** The longest irregular phrase considered; past it the grid has simply moved on. */
const MAX_IRREGULAR_BARS = 15;

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

  const loudRef = percentile(features.totalDb, 90);
  const audible = features.totalDb.map((db) => db >= loudRef - AUDIBLE_DB);
  const starts = choosePhraseLines(computeNovelty(features, barCount), barCount, audible);

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

export function measureBars(
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

export function classifyBars(features: BarFeatures): BlockState[] {
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
export function computeNovelty(features: BarFeatures, barCount: number): number[] {
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

/**
 * Phrase lines (bar 0 first): an 8-bar grid that follows the changes, and moves where the
 * music does. Only bars where the change peaks count (a boundary smears over its neighbours,
 * which must not count twice), squared, so a few real boundaries outweigh many small in-phrase
 * ones (a chord change every bar, say). A phrase of another length (a 4-bar break, a 2-bar
 * fill) is allowed where the boundaries after it make up for its cost; the stretch before the
 * first line (a pickup) is free, and so is the one after the last.
 *
 * Left out: bars whose look-ahead runs past the end (the ending itself too: a fade or an edit
 * stops wherever it stops, and on tracks with weak inside boundaries a vote for it decided the
 * grid against both the intro's and the outro's sections), and changes whose context reaches
 * into near-silence (a fade-in reads as the biggest change of the track).
 */
export function choosePhraseLines(novelty: number[], barCount: number, audible?: boolean[]): number[] {
  const usable = Math.min(novelty.length, barCount - Math.max(...NOVELTY_SCALES) + 1);
  const context = Math.min(...NOVELTY_SCALES);
  const heard = (bar: number) => {
    if (!audible) return true;
    for (let b = Math.max(0, bar - context); b < Math.min(barCount, bar + context); b++) if (!audible[b]) return false;
    return true;
  };
  const isPeak = (bar: number) =>
    novelty[bar] > 0 && novelty[bar] >= (novelty[bar - 1] ?? -1) && novelty[bar] >= (novelty[bar + 1] ?? -1) && heard(bar);
  const peaks: number[] = [];
  for (let bar = 1; bar < usable; bar++) if (isPeak(bar)) peaks.push(bar);
  const regular = () => {
    const lines = [0];
    for (let bar = PHRASE_BARS; bar < barCount; bar += PHRASE_BARS) lines.push(bar);
    return lines;
  };
  if (peaks.length === 0) return regular();

  // Gains relative to the strongest few boundaries, so the cost means the same on every track.
  const strongest = peaks.map((bar) => novelty[bar] ** 2).sort((a, b) => b - a).slice(0, 4);
  const scale = strongest.reduce((sum, v) => sum + v, 0) / strongest.length || 1;
  const gain = new Array<number>(barCount).fill(0);
  for (const bar of peaks) gain[bar] = novelty[bar] ** 2 / scale;
  const cost = (bars: number) =>
    bars === PHRASE_BARS
      ? 0
      : bars === PHRASE_BARS / 2 || bars === (3 * PHRASE_BARS) / 2
        ? IRREGULAR_PHRASE_COST
        : bars % 2 === 0
          ? 1.25 * IRREGULAR_PHRASE_COST
          : 1.5 * IRREGULAR_PHRASE_COST;

  // best[b]: the highest score of a grid with a line on bar b; from[b]: the line before it.
  const best = new Array<number>(barCount).fill(-Infinity);
  const from = new Array<number>(barCount).fill(0);
  for (let bar = 1; bar < barCount; bar++) {
    let score = bar <= PHRASE_BARS ? 0 : -Infinity;
    let previous = 0;
    for (let bars = 1; bars <= MAX_IRREGULAR_BARS && bars < bar; bars++) {
      const candidate = best[bar - bars] - cost(bars);
      if (candidate > score) {
        score = candidate;
        previous = bar - bars;
      }
    }
    best[bar] = score + gain[bar];
    from[bar] = previous;
  }
  let last = 0;
  for (let bar = Math.max(1, barCount - MAX_IRREGULAR_BARS); bar < barCount; bar++) {
    if (last === 0 || best[bar] > best[last]) last = bar;
  }
  const lines: number[] = [];
  for (let bar = last; bar > 0; bar = from[bar]) lines.push(bar);
  lines.reverse();
  // Past the last boundary that counted, the grid runs on regularly to the end.
  for (let bar = (lines[lines.length - 1] ?? 0) + PHRASE_BARS; bar < barCount; bar += PHRASE_BARS) lines.push(bar);
  return [0, ...lines];
}

function labelBlocks(
  features: BarFeatures,
  blocks: { start: number; end: number; state: BlockState }[],
): Phrase[] {
  // Runs of 8-bar blocks with the same state form one section. A block of another length (the
  // pickup before the first line, a break that moves the grid, the end) stands alone, so every
  // phrase line can be read back off the sections (see `phraseLines` in mixPoints).
  const regular = (b: { start: number; end: number }) => (b.end - b.start) % PHRASE_BARS === 0;
  const sections: { start: number; end: number; state: BlockState }[] = [];
  for (const block of blocks) {
    const previous = sections[sections.length - 1];
    const same =
      previous &&
      regular(previous) &&
      regular(block) &&
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
