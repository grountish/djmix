import { BUTTERWORTH4_Q, filtfilt, highpass, lowpass, median, percentile, powerToDb } from '../analysis/dsp';
import {
  K_WEIGHTING_OFFSET_DB,
  accumulateWeightedPower,
  kWeighting,
  measureLoudness,
} from '../analysis/loudness';
import { LOW_MID_CROSSOVER, MID_HIGH_CROSSOVER } from '../analysis/spectrum';
import { type BalanceReport, type Band, BANDS } from './balance';

/**
 * Transition quality metrics measured on an offline render: kick alignment between the decks,
 * low-band collisions, short-term loudness stability and peak level. Pure functions on sample
 * buffers, so tests, the mixlab CLI and the planner all score a transition the same way.
 */

export interface TransitionTargets {
  /** Largest kick offset between the decks, ms (exclusive). */
  maxBeatErrorMs: number;
  /** A deck's low band counts as playing above this level relative to its loudest beat. */
  lowBandThresholdDb: number;
  /** Largest short-term loudness deviation from the overlap's median, LU. */
  maxLoudnessDeviationLu: number;
  /** Highest master sample peak, dBFS. */
  maxPeakDb: number;
  /** Largest amount a band may measure above the plan's reference level, dB. */
  maxStackingDb: number;
  /** Deepest a band may measure below the plan's reference level, dB. */
  maxHoleDb: number;
}

/** Phase 4 exit criteria (docs/AUTOMIX_PLAN.md). */
export const TRANSITION_TARGETS: TransitionTargets = {
  maxBeatErrorMs: 5,
  lowBandThresholdDb: -15,
  maxLoudnessDeviationLu: 1,
  maxPeakDb: -1,
  maxStackingDb: 3,
  maxHoleDb: 6,
};

// Kick envelope parameters copied from the analyzer (beatGrid.ts) so a measured offset of zero
// means the same thing as a perfectly applied grid. Keep the two in sync.
const KICK_CUTOFF_HZ = 150;
const KICK_ENVELOPE_HZ = 80;
const KICK_ENVELOPE_RATE = 2000;
const KICK_ENVELOPE_SMOOTHING = 0.004;

/** Kicks are searched within this share of a beat around each expected beat. */
const KICK_SEARCH_BEATS = 0.25;
/**
 * A clear kick peaks this many times above the mean envelope just before its rise (from/to,
 * seconds before the 50% point). The mean, not the minimum: the ripple of a sustained bass tone
 * has deep troughs but a high mean.
 */
const MIN_KICK_PUNCH = 3;
const PRE_ONSET_FROM = 0.05;
const PRE_ONSET_TO = 0.008;
/**
 * A clear kick also comes within this many dB of the signal's typical loud kick (90th
 * percentile), which rejects chord changes low enough to reach the kick band.
 */
const MIN_KICK_LEVEL_DB = -15;
const KICK_REFERENCE_PERCENTILE = 90;
/**
 * Kicks averaged on each side of a beat before its 50% point is read. A bass or chord tone
 * under the kick beats against it and moves a single kick's 50% point by up to ~10 ms; its
 * phase changes from beat to beat, so averaging cancels it (as the analyzer's whole-track
 * template does). A real offset or drift survives; a sudden jump shows in full this many beats
 * after it happens.
 */
const KICK_AVERAGE_NEIGHBOURS = 4;

/** Below this a deck's low band is silence or noise, not a bassline, whatever its relative level. */
const LOW_BAND_SILENCE_DB = -80;

const EBU_SHORT_TERM_SECONDS = 3;
const EBU_HOP_SECONDS = 0.1;

interface KickEnvelope {
  values: Float32Array;
  /** Value j describes time (j + 0.5) / rate. */
  rate: number;
}

/**
 * The analyzer's low-band energy envelope: zero-phase low-pass (no delay) plus a quadrature
 * term that cancels the ripple a low tone leaves in x², smoothed with a centred boxcar so a
 * step's 50% point stays put.
 */
function kickEnvelope(signal: Float32Array, sampleRate: number): KickEnvelope {
  const low = filtfilt(
    signal,
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

/** Each beat's length: up to the next beat; the last lasts as long as the one before. */
function beatLengths(beatTimes: number[]): number[] {
  return beatTimes.map((time, k) => {
    if (k + 1 < beatTimes.length) return beatTimes[k + 1] - time;
    return k > 0 ? time - beatTimes[k - 1] : 0;
  });
}

function envelopeAt(envelope: KickEnvelope, time: number): number {
  const position = time * envelope.rate - 0.5;
  const i = Math.floor(position);
  if (i < 0 || i + 1 >= envelope.values.length) return 0;
  const frac = position - i;
  return envelope.values[i] * (1 - frac) + envelope.values[i + 1] * frac;
}

/** Envelope ±`half` samples around `time`, added into `out`. */
function addAround(envelope: KickEnvelope, time: number, half: number, out: Float64Array): void {
  for (let s = -half; s <= half; s++) out[s + half] += envelopeAt(envelope, time + s / envelope.rate);
}

interface Rise {
  /** 50% point relative to the segment centre, envelope samples. */
  offset: number;
  peak: number;
  /** Mean level just before the rise. */
  before: number;
}

/**
 * The analyzer's beat on a segment centred on an expected beat: the peak within ±`reach`
 * samples, the floor as the minimum over `reach` samples before it, and the point where the
 * envelope rises halfway from floor to peak.
 */
function findRise(segment: Float64Array, reach: number, rate: number): Rise | null {
  const centre = (segment.length - 1) / 2;
  let peak = centre - reach;
  for (let i = peak + 1; i <= centre + reach; i++) if (segment[i] > segment[peak]) peak = i;
  // Still rising at the edge: the bump belongs to a later event.
  if (peak === centre + reach || segment[peak] <= 0) return null;

  let floor = segment[peak];
  for (let i = Math.max(0, peak - reach); i < peak; i++) floor = Math.min(floor, segment[i]);
  const level = floor + 0.5 * (segment[peak] - floor);
  if (!(level > floor)) return null;

  // Stops at the floor at the latest, so it stays inside the segment.
  let i = peak;
  while (segment[i - 1] >= level) i--;
  const crossing = i - 1 + (level - segment[i - 1]) / (segment[i] - segment[i - 1]);
  if (Math.abs(crossing - centre) > reach) return null;

  const from = Math.max(0, Math.round(crossing - PRE_ONSET_FROM * rate));
  const to = Math.max(from + 1, Math.round(crossing - PRE_ONSET_TO * rate));
  let before = 0;
  for (let j = from; j < to; j++) before += segment[j];
  return { offset: crossing - centre, peak: segment[peak], before: before / (to - from) };
}

/**
 * Kick onset (seconds) near each expected beat of a mono signal: the 50% rise point of the
 * low-band envelope within ±¼ beat, read on the kicks averaged over neighbouring beats. Null
 * where the beat itself has no clear kick (breakdowns, silence).
 */
export function kickOnsets(
  signal: Float32Array,
  sampleRate: number,
  beatTimes: number[],
): (number | null)[] {
  const envelope = kickEnvelope(signal, sampleRate);
  const lengths = beatLengths(beatTimes);
  // Segments span ±½ beat, so the floor before a peak at -¼ beat is still inside.
  const halfOf = (k: number) => Math.round((lengths[k] / 2) * envelope.rate);
  const reachOf = (k: number) => Math.round(KICK_SEARCH_BEATS * lengths[k] * envelope.rate);
  const averageAround = (k: number, beats: number[]) => {
    const half = halfOf(k);
    const out = new Float64Array(2 * half + 1);
    for (const m of beats) addAround(envelope, beatTimes[m], half, out);
    return out;
  };

  const rises = beatTimes.map((_, k) => {
    if (reachOf(k) < 2) return null;
    const rise = findRise(averageAround(k, [k]), reachOf(k), envelope.rate);
    return rise && rise.peak >= MIN_KICK_PUNCH * rise.before ? rise : null;
  });
  const peaks = rises.flatMap((rise) => (rise ? [rise.peak] : []));
  const minPeak = percentile(peaks, KICK_REFERENCE_PERCENTILE) * Math.pow(10, MIN_KICK_LEVEL_DB / 10);
  const clear = rises.map((rise) => rise !== null && rise.peak >= minPeak);

  return beatTimes.map((time, k) => {
    if (!clear[k]) return null;
    const neighbours: number[] = [];
    const last = Math.min(beatTimes.length - 1, k + KICK_AVERAGE_NEIGHBOURS);
    for (let m = Math.max(0, k - KICK_AVERAGE_NEIGHBOURS); m <= last; m++) {
      if (clear[m]) neighbours.push(m);
    }
    const rise = findRise(averageAround(k, neighbours), reachOf(k), envelope.rate);
    return rise ? time + rise.offset / envelope.rate : null;
  });
}

export interface BeatOffset {
  /** Index into the expected beat times. */
  beat: number;
  /** Kick onset in b minus kick onset in a, ms. */
  diffMs: number;
}

export interface AlignmentSummary {
  /** Beats where both signals have a clear kick; the stats are NaN when this is 0. */
  count: number;
  meanMs: number;
  /** Typical offset, robust to the odd misread kick. */
  medianMs: number;
  maxAbsMs: number;
  p95AbsMs: number;
}

export interface BeatAlignment {
  beats: BeatOffset[];
  summary: AlignmentSummary;
}

/**
 * Per-beat kick offset between two mono signals (b − a, see `kickOnsets`), over the beats where
 * both have a clear kick. Feed signals tapped before the EQ: its crossovers delay the low band,
 * and a killed low band would hide the incoming kicks.
 */
export function beatAlignment(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
  beatTimes: number[],
): BeatAlignment {
  const onsetsA = kickOnsets(a, sampleRate, beatTimes);
  const onsetsB = kickOnsets(b, sampleRate, beatTimes);
  const beats: BeatOffset[] = [];
  onsetsA.forEach((onsetA, beat) => {
    const onsetB = onsetsB[beat];
    if (onsetA !== null && onsetB !== null) beats.push({ beat, diffMs: (onsetB - onsetA) * 1000 });
  });

  if (beats.length === 0) {
    return { beats, summary: { count: 0, meanMs: NaN, medianMs: NaN, maxAbsMs: NaN, p95AbsMs: NaN } };
  }
  const absolute = beats.map((offset) => Math.abs(offset.diffMs));
  return {
    beats,
    summary: {
      count: beats.length,
      meanMs: beats.reduce((sum, offset) => sum + offset.diffMs, 0) / beats.length,
      medianMs: median(beats.map((offset) => offset.diffMs)),
      maxAbsMs: absolute.reduce((max, value) => Math.max(max, value), 0),
      p95AbsMs: percentile(absolute, 95),
    },
  };
}

export interface LowBandCollisions {
  collisions: number;
  /** Indices of the colliding beats. */
  beats: number[];
  /** Per-beat low-band level of each signal relative to its own loudest beat, dB. */
  aDb: number[];
  bDb: number[];
}

/** Mean square of the low band (< 200 Hz, the isolator's crossover) over each beat. */
function lowBandPower(signal: Float32Array, sampleRate: number, beatTimes: number[]): number[] {
  const low = filtfilt(
    signal,
    BUTTERWORTH4_Q.map((q) => lowpass(LOW_MID_CROSSOVER, sampleRate, q)),
  );
  const lengths = beatLengths(beatTimes);
  return beatTimes.map((time, k) => {
    const start = Math.max(0, Math.round(time * sampleRate));
    const end = Math.min(low.length, Math.round((time + lengths[k]) * sampleRate));
    let sum = 0;
    for (let i = start; i < end; i++) sum += low[i] * low[i];
    return end > start ? sum / (end - start) : 0;
  });
}

/**
 * Beats where both decks' low bands play: each above `thresholdDb` relative to that deck's own
 * loudest beat in the window. Feed signals tapped after the channel faders, so EQ kills and
 * fader moves count. A beat spans from its time to the next beat.
 */
export function lowBandCollisions(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
  beatTimes: number[],
  thresholdDb: number = TRANSITION_TARGETS.lowBandThresholdDb,
): LowBandCollisions {
  const powerA = lowBandPower(a, sampleRate, beatTimes);
  const powerB = lowBandPower(b, sampleRate, beatTimes);
  const relative = (powers: number[]) => {
    const loudest = powerToDb(powers.reduce((max, p) => Math.max(max, p), 0));
    return powers.map((p) => powerToDb(p) - loudest);
  };
  const aDb = relative(powerA);
  const bDb = relative(powerB);

  const playing = (power: number, db: number) =>
    powerToDb(power) > LOW_BAND_SILENCE_DB && db > thresholdDb;
  const beats: number[] = [];
  for (let k = 0; k < beatTimes.length; k++) {
    if (playing(powerA[k], aDb[k]) && playing(powerB[k], bDb[k])) beats.push(k);
  }
  return { collisions: beats.length, beats, aDb, bDb };
}

export interface LoudnessSeries {
  /** Centre of each window, seconds. */
  times: number[];
  lufs: number[];
}

/**
 * EBU R128 short-term loudness (K-weighted, ungated, 3 s window) every `hopSeconds`. Times are
 * window centres rather than window ends, so a value lines up with the music it measures.
 * Silence reads about -121 LUFS instead of -∞.
 */
export function shortTermLoudness(
  channels: Float32Array[],
  sampleRate: number,
  windowSeconds: number = EBU_SHORT_TERM_SECONDS,
  hopSeconds: number = EBU_HOP_SECONDS,
): LoudnessSeries {
  const series: LoudnessSeries = { times: [], lufs: [] };
  if (channels.length === 0) return series;

  const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
  const hopsPerWindow = Math.max(1, Math.round(windowSeconds / hopSeconds));
  const hops = Math.floor(channels[0].length / hop);
  const hopPower = new Float64Array(hops);
  const filters = kWeighting(sampleRate);
  for (const channel of channels) accumulateWeightedPower(channel, filters, hop, hopPower);

  const windowSamples = hopsPerWindow * hop;
  for (let start = 0; start + hopsPerWindow <= hops; start++) {
    let sum = 0;
    for (let i = start; i < start + hopsPerWindow; i++) sum += hopPower[i];
    series.times.push((start * hop + windowSamples / 2) / sampleRate);
    series.lufs.push(K_WEIGHTING_OFFSET_DB + powerToDb(sum / windowSamples));
  }
  return series;
}

/**
 * Largest distance (LU) of the short-term loudness from its median, over windows centred in
 * [fromSeconds, toSeconds]. NaN when no window falls in the range.
 */
export function loudnessDeviation(
  series: LoudnessSeries,
  fromSeconds: number,
  toSeconds: number,
): number {
  const values = series.lufs.filter(
    (_, i) => series.times[i] >= fromSeconds && series.times[i] <= toSeconds,
  );
  if (values.length === 0) return NaN;
  const centre = median(values);
  return values.reduce((max, value) => Math.max(max, Math.abs(value - centre)), 0);
}

/** Highest absolute sample over all channels, dBFS (-120 for silence). */
export function samplePeakDb(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
  }
  return powerToDb(peak * peak);
}

/*
 * Grid-free timing. The alignment above reads kicks around *expected* beats, so it inherits
 * each track's grid: a grid half a beat off puts that deck's kicks outside the search window
 * and they are quietly skipped (that is how an out-of-sync mix once measured as locked). The
 * phase offset below uses only the beat period, never a grid phase.
 */

/** Local maxima of the kick envelope are looked for over ±this window (s). */
const ONSET_PEAK_WINDOW = 0.06;
/** The floor before a peak is the minimum over this long before it (s). */
const ONSET_FLOOR_WINDOW = 0.12;
/** Onsets closer than this are one event (s). */
const ONSET_MIN_GAP = 0.06;
/**
 * A kick's low band decays within a fifth of a second; a bass note holds. The envelope over
 * the hit (s after the onset) must sit this far above its tail for an onset to be a kick —
 * the analyzer's own discriminator (beatGrid.ts), so bass notes between kicks don't count.
 */
const ONSET_DECAY_EARLY: [number, number] = [0.005, 0.045];
const ONSET_DECAY_LATE: [number, number] = [0.12, 0.2];
const MIN_ONSET_DECAY_DB = 3;

interface LowOnset {
  time: number;
  peak: number;
}

/**
 * Kick onsets of a mono signal between `from` and `to`, found without a beat grid: peaks of
 * the low-band envelope that rise clearly (MIN_KICK_PUNCH) out of what came before them,
 * reach the signal's typical kick level and decay like a kick, read at their 50% rise point
 * like the analyzer's beats.
 */
function pickLowOnsets(signal: Float32Array, sampleRate: number, from: number, to: number): LowOnset[] {
  const { values, rate } = kickEnvelope(signal, sampleRate);
  const peakHalf = Math.max(1, Math.round(ONSET_PEAK_WINDOW * rate));
  const floorWindow = Math.max(1, Math.round(ONSET_FLOOR_WINDOW * rate));
  const first = Math.max(peakHalf, Math.floor(from * rate));
  const last = Math.min(values.length - peakHalf - 1, Math.ceil(to * rate));
  const meanOver = (start: number, window: [number, number]) => {
    const a = Math.min(values.length, Math.max(0, Math.round(start + window[0] * rate)));
    const b = Math.min(values.length, Math.max(a + 1, Math.round(start + window[1] * rate)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += values[j];
    return sum / (b - a);
  };

  const candidates: LowOnset[] = [];
  for (let i = first; i <= last; i++) {
    const v = values[i];
    if (v <= 0) continue;
    let isPeak = true;
    for (let j = i - peakHalf; j <= i + peakHalf && isPeak; j++) {
      if (values[j] > v || (values[j] === v && j < i)) isPeak = false;
    }
    if (!isPeak) continue;
    let floor = v;
    for (let j = Math.max(0, i - floorWindow); j < i; j++) floor = Math.min(floor, values[j]);
    const level = floor + 0.5 * (v - floor);
    if (!(level > floor)) continue;
    let k = i;
    while (k > 0 && values[k - 1] >= level) k--;
    const crossing = k === 0 ? 0 : k - 1 + (level - values[k - 1]) / (values[k] - values[k - 1]);
    const before = meanOver(crossing, [-PRE_ONSET_FROM, -PRE_ONSET_TO]);
    if (v < MIN_KICK_PUNCH * before) continue;
    const early = meanOver(crossing, ONSET_DECAY_EARLY);
    const late = meanOver(crossing, ONSET_DECAY_LATE);
    if (!(early > 0) || powerToDb(early) - powerToDb(late) < MIN_ONSET_DECAY_DB) continue;
    candidates.push({ time: crossing / rate, peak: v });
  }
  if (candidates.length === 0) return [];

  const minPeak =
    percentile(candidates.map((c) => c.peak), KICK_REFERENCE_PERCENTILE) * Math.pow(10, MIN_KICK_LEVEL_DB / 10);
  const onsets: LowOnset[] = [];
  for (const candidate of candidates) {
    if (candidate.peak < minPeak) continue;
    if (onsets.length > 0 && candidate.time - onsets[onsets.length - 1].time < ONSET_MIN_GAP) continue;
    onsets.push(candidate);
  }
  return onsets;
}

/** Kick onset times (seconds) of a mono signal, found without a beat grid (see pickLowOnsets). */
export function lowOnsets(signal: Float32Array, sampleRate: number, from = 0, to = Infinity): number[] {
  return pickLowOnsets(signal, sampleRate, from, to).map((onset) => onset.time);
}

export interface PhaseOffset {
  /**
   * Lag of b's low-band rhythm behind a's within ±half a beat period, ms: the kick offset
   * between the decks. NaN when the two envelopes don't correlate enough to tell.
   */
  offsetMs: number;
  /** Normalised peak correlation of the two envelopes (0–1): how sure the offset is. */
  correlation: number;
  /** Resultant length (0–1) of each deck's onset phases: 1 = every kick on one phase of the period. */
  coherence: { a: number; b: number };
  onsets: { a: number; b: number };
}

/** Below this normalised correlation the two decks share no rhythm to read a lag from. */
const MIN_LAG_CORRELATION = 0.2;

/**
 * Kick offset between two decks read from the beat period alone: the lag, within ±half a
 * period, at which the two low-band envelopes correlate best. No grid phase, no expected
 * beats and no onset classification are involved, so a bass line under the kicks does not
 * bias it, and a deck whose kicks sit half a beat off the other's reads as ±period/2 — which
 * the grid-based alignment cannot see. The onset fold supplies how regular each deck's kicks
 * are and how many there were.
 */
export function kickPhaseOffset(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
  periodSeconds: number,
  from = 0,
  to = Infinity,
): PhaseOffset {
  const lag = envelopeLag(a, b, sampleRate, periodSeconds / 2, from, to);
  // Onsets vote with their strength, so a stray soft event cannot pull the phase.
  const fold = (onsets: LowOnset[]) => {
    let re = 0;
    let im = 0;
    let weight = 0;
    for (const { time, peak } of onsets) {
      const phase = (2 * Math.PI * (time - from)) / periodSeconds;
      re += peak * Math.cos(phase);
      im += peak * Math.sin(phase);
      weight += peak;
    }
    return weight > 0 ? Math.hypot(re, im) / weight : 0;
  };
  const onsetsA = pickLowOnsets(a, sampleRate, from, to);
  const onsetsB = pickLowOnsets(b, sampleRate, from, to);
  return {
    offsetMs: lag.correlation >= MIN_LAG_CORRELATION ? lag.lagSeconds * 1000 : NaN,
    correlation: lag.correlation,
    coherence: { a: fold(onsetsA), b: fold(onsetsB) },
    onsets: { a: onsetsA.length, b: onsetsB.length },
  };
}

/**
 * Lag (seconds, b behind a) within ±maxLag at which the two signals' kick envelopes, mean
 * removed over [from, to], correlate best, refined to a fraction of an envelope sample, and
 * the normalised correlation there.
 */
function envelopeLag(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
  maxLagSeconds: number,
  from: number,
  to: number,
): { lagSeconds: number; correlation: number } {
  const envA = kickEnvelope(a, sampleRate);
  const envB = kickEnvelope(b, sampleRate);
  const rate = envA.rate;
  const start = Math.max(0, Math.floor(from * rate));
  const end = Math.min(envA.values.length, envB.values.length, Math.ceil(to * rate));
  const maxLag = Math.max(1, Math.round(maxLagSeconds * rate));
  const length = end - start - 2 * maxLag;
  if (length < 2) return { lagSeconds: NaN, correlation: 0 };

  // a over the inner window; b slides over it by the lag.
  const centre = (values: Float32Array, offset: number) => {
    let mean = 0;
    for (let i = 0; i < length; i++) mean += values[offset + i];
    mean /= length;
    const out = new Float64Array(length);
    for (let i = 0; i < length; i++) out[i] = values[offset + i] - mean;
    return out;
  };
  const windowA = centre(envA.values, start + maxLag);
  const normA = Math.sqrt(windowA.reduce((sum, v) => sum + v * v, 0));
  const scores = new Float64Array(2 * maxLag + 1);
  let best = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const windowB = centre(envB.values, start + maxLag + lag);
    let dot = 0;
    let normB = 0;
    for (let i = 0; i < length; i++) {
      dot += windowA[i] * windowB[i];
      normB += windowB[i] * windowB[i];
    }
    const score = normA > 0 && normB > 0 ? dot / (normA * Math.sqrt(normB)) : 0;
    scores[lag + maxLag] = score;
    if (score > scores[best]) best = lag + maxLag;
  }
  const correlation = scores[best];
  if (!(correlation > 0)) return { lagSeconds: NaN, correlation: 0 };
  const refined =
    best > 0 && best < scores.length - 1 ? best + parabolicPeak(scores[best - 1], scores[best], scores[best + 1]) : best;
  return { lagSeconds: (refined - maxLag) / rate, correlation };
}

/** Offset (−0.5 … 0.5 samples) of the parabola through three neighbouring values' peak. */
function parabolicPeak(left: number, centre: number, right: number): number {
  const denominator = left - 2 * centre + right;
  return denominator < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator)) : 0;
}

export interface BandLevels {
  outgoing: Record<Band, number[]>;
  incoming: Record<Band, number[]>;
  /** Both decks together (power sum), dB. */
  sum: Record<Band, number[]>;
}

/**
 * Per bar (barTimes[k] … barTimes[k+1]), each deck's level in the isolator's three bands after
 * its fader, dB, and the two together. The same crossovers as the mixer and the analysis, so
 * these compare with a plan's forecast.
 */
export function bandLevels(
  taps: { outgoing: Float32Array; incoming: Float32Array },
  sampleRate: number,
  barTimes: number[],
): BandLevels {
  const butterworth = (make: (q: number) => ReturnType<typeof lowpass>) => BUTTERWORTH4_Q.map(make);
  const split = (signal: Float32Array): Record<Band, Float32Array> => {
    const upper = filtfilt(signal, butterworth((q) => highpass(LOW_MID_CROSSOVER, sampleRate, q)));
    return {
      low: filtfilt(signal, butterworth((q) => lowpass(LOW_MID_CROSSOVER, sampleRate, q))),
      mid: filtfilt(upper, butterworth((q) => lowpass(MID_HIGH_CROSSOVER, sampleRate, q))),
      high: filtfilt(upper, butterworth((q) => highpass(MID_HIGH_CROSSOVER, sampleRate, q))),
    };
  };
  const barPower = (x: Float32Array, k: number) => {
    const start = Math.max(0, Math.round(barTimes[k] * sampleRate));
    const end = Math.min(x.length, Math.round(barTimes[k + 1] * sampleRate));
    let sum = 0;
    for (let i = start; i < end; i++) sum += x[i] * x[i];
    return end > start ? sum / (end - start) : 0;
  };
  const out = split(taps.outgoing);
  const inc = split(taps.incoming);
  const levels: BandLevels = {
    outgoing: { low: [], mid: [], high: [] },
    incoming: { low: [], mid: [], high: [] },
    sum: { low: [], mid: [], high: [] },
  };
  for (const band of BANDS) {
    for (let k = 0; k + 1 < barTimes.length; k++) {
      const pOut = barPower(out[band], k);
      const pIn = barPower(inc[band], k);
      levels.outgoing[band].push(powerToDb(pOut));
      levels.incoming[band].push(powerToDb(pIn));
      levels.sum[band].push(powerToDb(pOut + pIn));
    }
  }
  return levels;
}

/** Bars at the start of the overlap, where only the outgoing deck plays, that calibrate the forecast. */
const CALIBRATION_BARS = 2;

export interface ForecastCheck {
  /** Per band: dB added to the forecast to put it on the render's scale (measured over the first bars). */
  calibrationDb: Record<Band, number>;
  /** Per band and bar: measured sum minus the forecast's balanced sum, dB. */
  errorDb: Record<Band, number[]>;
  rmsErrorDb: number;
  maxAbsErrorDb: number;
  /** Largest amount the measured sum rises above the forecast's reference, dB: stacking the ear gets. */
  measuredExcessDb: number;
  /** Deepest the measured sum falls below the reference, dB: a hole the ear gets. */
  measuredHoleDb: number;
}

/**
 * The plan's forecast against what the render measured, band by band and bar by bar. The
 * analysis and the render count level on different scales, so each band is calibrated on
 * the overlap's first bars, where the outgoing deck plays alone at unity.
 */
export function checkForecast(levels: BandLevels, forecast: BalanceReport): ForecastCheck {
  const bars = levels.sum.low.length;
  const calibrationDb = {} as Record<Band, number>;
  const errorDb = {} as Record<Band, number[]>;
  let squares = 0;
  let count = 0;
  let maxAbs = 0;
  let excess = 0;
  let hole = 0;
  const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
  // A measured bar spans [b, b+1); the forecast gives instants, so take its mid-bar value.
  const midBar = (series: number[], b: number) => {
    const here = series[b];
    const next = series[b + 1];
    return finite(here) && finite(next) ? (here + next) / 2 : finite(here) ? here : NaN;
  };

  for (const band of BANDS) {
    let offsets = 0;
    let n = 0;
    for (let b = 0; b < Math.min(CALIBRATION_BARS, bars); b++) {
      const measured = levels.outgoing[band][b];
      const predicted = midBar(forecast.levels.outgoing[band], b);
      if (finite(measured) && finite(predicted) && measured > -100 && predicted > -100) {
        offsets += measured - predicted;
        n++;
      }
    }
    const calibration = n > 0 ? offsets / n : 0;
    calibrationDb[band] = calibration;
    errorDb[band] = [];
    for (let b = 0; b < bars; b++) {
      const measured = levels.sum[band][b];
      const predicted = midBar(forecast.bands[band].balanced, b) + calibration;
      const reference = midBar(forecast.bands[band].reference, b) + calibration;
      const error = finite(measured) && finite(predicted) ? measured - predicted : NaN;
      errorDb[band].push(error);
      if (b === 0 || b === bars - 1 || !finite(error)) continue;
      squares += error * error;
      count++;
      maxAbs = Math.max(maxAbs, Math.abs(error));
      if (finite(reference)) {
        excess = Math.max(excess, measured - reference);
        hole = Math.max(hole, reference - measured);
      }
    }
  }
  return {
    calibrationDb,
    errorDb,
    rmsErrorDb: count > 0 ? Math.sqrt(squares / count) : NaN,
    maxAbsErrorDb: count > 0 ? maxAbs : NaN,
    measuredExcessDb: count > 0 ? excess : NaN,
    measuredHoleDb: count > 0 ? hole : NaN,
  };
}

/** One offline-rendered transition, all signals on the same timeline. */
export interface RenderedTransition {
  sampleRate: number;
  /** Mono deck signals before the EQ, for kick timing. */
  timingTaps: { outgoing: Float32Array; incoming: Float32Array };
  /** Mono deck signals after the channel faders, for band levels. */
  levelTaps: { outgoing: Float32Array; incoming: Float32Array };
  master: Float32Array[];
  /** Expected beat times through the overlap, seconds. */
  overlapBeatTimes: number[];
  overlapStart: number;
  overlapEnd: number;
  /** Indices into `overlapBeatTimes` where both lows may play (the bass-swap beat). */
  allowedCollisionBeats?: number[];
  /** Beat period during the overlap (the meeting tempo), seconds: enables the grid-free phase offset. */
  periodSeconds?: number;
  /** Clock time of every overlap bar line, 0 … overlapBars: enables the band-level check. */
  barTimes?: number[];
  /** The plan's forecast (`plan.balance`): enables the forecast check. */
  forecast?: BalanceReport;
}

/** Fewer beats with a clear kick on both decks than this can't tell timing from noise. */
export const MIN_ALIGNED_BEATS = 8;

export interface TransitionChecks {
  /** null when too few beats had a clear kick on both decks to judge. */
  beatAlignment: boolean | null;
  /** Grid-free kick phase offset within the target; null without a usable phase (or no period given). */
  phase: boolean | null;
  lowBand: boolean;
  /** Short-term loudness within the target of the overlap's median; null (advisory) with a forecast. */
  loudness: boolean | null;
  peak: boolean;
  /** No band measured above the plan's reference by more than the target; null without a forecast. */
  stacking: boolean | null;
  /** No band measured below the plan's reference by more than the target; null without a forecast. */
  hole: boolean | null;
}

export interface TransitionMetrics {
  alignment: BeatAlignment;
  /** Kick offset read from the beat period alone (see kickPhaseOffset); absent without a period. */
  phase?: PhaseOffset;
  collisions: LowBandCollisions;
  /** Collision beats outside `allowedCollisionBeats`. */
  unexpectedCollisionBeats: number[];
  loudness: LoudnessSeries;
  loudnessDeviationLu: number;
  samplePeakDb: number;
  /** 4× oversampled (BS.1770); informational, the check uses the sample peak. */
  truePeakDb: number;
  /** Measured band levels per overlap bar; absent without bar times. */
  bands?: BandLevels;
  /** The forecast against the render; absent without a forecast and bar times. */
  forecast?: ForecastCheck;
  checks: TransitionChecks;
  pass: boolean;
}

/**
 * Every metric of a rendered transition and its verdict against the targets. Alignment only
 * passes when at least one beat could be measured.
 */
export function summarizeTransition(
  input: RenderedTransition,
  targets: TransitionTargets = TRANSITION_TARGETS,
): TransitionMetrics {
  const { sampleRate, overlapBeatTimes, timingTaps, levelTaps, master } = input;
  const alignment = beatAlignment(timingTaps.outgoing, timingTaps.incoming, sampleRate, overlapBeatTimes);
  const phase =
    input.periodSeconds !== undefined
      ? kickPhaseOffset(timingTaps.outgoing, timingTaps.incoming, sampleRate, input.periodSeconds, input.overlapStart, input.overlapEnd)
      : undefined;
  const collisions = lowBandCollisions(
    levelTaps.outgoing,
    levelTaps.incoming,
    sampleRate,
    overlapBeatTimes,
    targets.lowBandThresholdDb,
  );
  const allowed = new Set(input.allowedCollisionBeats ?? []);
  const unexpectedCollisionBeats = collisions.beats.filter((beat) => !allowed.has(beat));
  const loudness = shortTermLoudness(master, sampleRate);
  const loudnessDeviationLu = loudnessDeviation(loudness, input.overlapStart, input.overlapEnd);
  const peakDb = samplePeakDb(master);
  const bands = input.barTimes && input.barTimes.length > 1 ? bandLevels(levelTaps, sampleRate, input.barTimes) : undefined;
  const forecast = bands && input.forecast ? checkForecast(bands, input.forecast) : undefined;

  const checks: TransitionChecks = {
    // p95, not the single worst beat: one misread kick in a hundred is the metric, not the mix.
    beatAlignment:
      alignment.summary.count < MIN_ALIGNED_BEATS ? null : alignment.summary.p95AbsMs < targets.maxBeatErrorMs,
    phase: phase && Number.isFinite(phase.offsetMs) ? Math.abs(phase.offsetMs) < targets.maxBeatErrorMs : null,
    lowBand: unexpectedCollisionBeats.length === 0,
    // A planned blend walks from one track's level to the other's; with a forecast to judge
    // the walk by (stacking, hole), the deviation from the median is information, not a verdict.
    loudness: forecast ? null : loudnessDeviationLu <= targets.maxLoudnessDeviationLu,
    peak: peakDb <= targets.maxPeakDb,
    stacking: forecast && Number.isFinite(forecast.measuredExcessDb) ? forecast.measuredExcessDb <= targets.maxStackingDb : null,
    hole: forecast && Number.isFinite(forecast.measuredHoleDb) ? forecast.measuredHoleDb <= targets.maxHoleDb : null,
  };
  return {
    alignment,
    ...(phase ? { phase } : {}),
    collisions,
    unexpectedCollisionBeats,
    loudness,
    loudnessDeviationLu,
    samplePeakDb: peakDb,
    truePeakDb: measureLoudness(master, sampleRate).truePeakDb,
    ...(bands ? { bands } : {}),
    ...(forecast ? { forecast } : {}),
    checks,
    pass: Object.values(checks).every((check) => check !== false),
  };
}
