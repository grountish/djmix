import { BUTTERWORTH4_Q, filtfilt, lowpass, median, percentile, powerToDb } from '../analysis/dsp';
import {
  K_WEIGHTING_OFFSET_DB,
  accumulateWeightedPower,
  kWeighting,
  measureLoudness,
} from '../analysis/loudness';
import { LOW_MID_CROSSOVER } from '../analysis/spectrum';

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
}

/** Phase 4 exit criteria (docs/AUTOMIX_PLAN.md). */
export const TRANSITION_TARGETS: TransitionTargets = {
  maxBeatErrorMs: 5,
  lowBandThresholdDb: -15,
  maxLoudnessDeviationLu: 1,
  maxPeakDb: -1,
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
}

/** Fewer beats with a clear kick on both decks than this can't tell timing from noise. */
export const MIN_ALIGNED_BEATS = 8;

export interface TransitionChecks {
  /** null when too few beats had a clear kick on both decks to judge. */
  beatAlignment: boolean | null;
  lowBand: boolean;
  loudness: boolean;
  peak: boolean;
}

export interface TransitionMetrics {
  alignment: BeatAlignment;
  collisions: LowBandCollisions;
  /** Collision beats outside `allowedCollisionBeats`. */
  unexpectedCollisionBeats: number[];
  loudness: LoudnessSeries;
  loudnessDeviationLu: number;
  samplePeakDb: number;
  /** 4× oversampled (BS.1770); informational, the check uses the sample peak. */
  truePeakDb: number;
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

  const checks: TransitionChecks = {
    beatAlignment:
      alignment.summary.count < MIN_ALIGNED_BEATS ? null : alignment.summary.maxAbsMs < targets.maxBeatErrorMs,
    lowBand: unexpectedCollisionBeats.length === 0,
    loudness: loudnessDeviationLu <= targets.maxLoudnessDeviationLu,
    peak: peakDb <= targets.maxPeakDb,
  };
  return {
    alignment,
    collisions,
    unexpectedCollisionBeats,
    loudness,
    loudnessDeviationLu,
    samplePeakDb: peakDb,
    truePeakDb: measureLoudness(master, sampleRate).truePeakDb,
    checks,
    pass: Object.values(checks).every((check) => check !== false),
  };
}
