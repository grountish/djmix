import type { MusicalKey } from '../analysis/key';
import type { AudioAnalysis, Phrase } from '../analysis/types';
import { bestKeyShift, harmonicScore, MIN_KEY_SHIFT_CONFIDENCE, transpose } from './harmonic';
import { DEFAULT_TEMPO_POLICY, planTempo, type TempoPlan, type TempoPolicy } from './tempoPlan';

export type TempoDirection = 'up' | 'down' | 'any';

export interface SequencerTrack {
  id: string;
  /** The track's own tempo. */
  bpm: number;
  /** `confidence` is 0–1 (tags count as 1); a key without one is never shifted. */
  key: MusicalKey & { confidence?: number };
  /** How hard the track drives, 0–1 (see `trackEnergy`). */
  energy: number;
}

export interface SequencerOptions {
  /** Which way the set's tempo travels; 'any' only asks for gradual steps. */
  direction: TempoDirection;
  /** Shift the incoming track up to a semitone (key lock) when that turns a clash into a match. */
  allowKeyShift: boolean;
  /** Both keys need this confidence before a shift: shifting on a misread key creates a clash. */
  minKeyShiftConfidence: number;
  tempoPolicy: TempoPolicy;
}

export const DEFAULT_SEQUENCER_OPTIONS: SequencerOptions = {
  direction: 'up',
  allowKeyShift: false,
  minKeyShiftConfidence: MIN_KEY_SHIFT_CONFIDENCE,
  tempoPolicy: DEFAULT_TEMPO_POLICY,
};

export interface TransitionScore {
  /** Weighted sum of the parts below; higher is better. */
  score: number;
  /** False when the tempos are too far apart to beatmatch; the transition becomes a cut. */
  canBlend: boolean;
  /** 1 at equal tempo, 0 at the widest bridgeable gap, `NO_BLEND_SCORE` beyond it. */
  tempo: number;
  /** 1 for a gradual step the set's way, down to −1 for a leap, and lower still for steps back. */
  direction: number;
  /** 0–1 Camelot compatibility after any key shift, less the shift's cost. */
  harmonic: number;
  /** −1…1: how well the energy change suits the set's arc. */
  energy: number;
  /** Semitones the incoming track plays away from its own key. */
  keyShift: number;
}

/** Weight of how far the blend pulls both tracks off their own tempo: the native-first policy. */
const TEMPO_WEIGHT = 1;
/** Weight of the set's tempo arc, the user's main ordering intent. */
const DIRECTION_WEIGHT = 1;
/** Weight of key compatibility: a clash spoils exactly the long melodic blends automix aims for. */
const HARMONIC_WEIGHT = 1;
/** Weight of energy flow: the proxy is coarse, so it steers between otherwise equal choices. */
const ENERGY_WEIGHT = 0.5;
/** Tempo part of a pair that can't be beatmatched: low enough that any blendable route wins. */
const NO_BLEND_SCORE = -4;

/** Steps up to 8% in the set's direction are gradual: each track moves ≤ 4% around the blend. */
const GRADUAL_STEP = Math.log(1.08);
/**
 * Each 2% against the direction costs a whole direction score, with no floor: a small dip can buy
 * a key match, but a step back costs the same whether taken at once or in pieces, so the set can
 * neither slide back nor drop and climb a second time to collect better key pairs.
 */
const AGAINST_STEP = Math.log(1.02);
/** Lowest score of an oversized leap the right way; beyond it the tempo part takes over. */
const LEAP_FLOOR = -1;

/** The plan's limit: a shift of a semitone either way, never more. */
const MAX_KEY_SHIFT = 1;
/** A shifted track no longer sounds quite as produced, so an equal match without a shift wins. */
const KEY_SHIFT_COST = 0.1;

/** The energy change that scores best: a gentle lift keeps the floor building. */
const IDEAL_ENERGY_STEP = 0.05;
/** A rise this far past the ideal loses the whole energy part: too abrupt. */
const ENERGY_JUMP = 0.5;
/** A fall this far below the ideal loses the whole part: drops empty floors faster than jumps tire them. */
const ENERGY_FALL = 0.25;

/** Kick-only bars drive the floor, but without a bassline they carry half the weight. */
const KICK_ONLY_DRIVE = 0.5;
/** Energy when the structure is unknown: neutral, so it neither attracts nor repels. */
const UNKNOWN_ENERGY = 0.5;

/** Partial orders kept per step: on random 40-track sets 64 lands within 0.5% of 512, in ~20 ms. */
const DEFAULT_BEAM_WIDTH = 64;
/**
 * The beam charges a skipped track twice the step back it would need now: it is usually fetched
 * only after the set has climbed further, so the real step back is longer.
 */
const LEFT_BEHIND_FACTOR = 2;

/**
 * Energy proxy, 0–1: the share of the track that grooves at full weight (kick and bassline),
 * kick-only bars counting half. Loudness is left out on purpose: every track is auto-gained to
 * the same LUFS target, so mastering level says little about what the floor hears; what still
 * differs after gain is how much of the track drives rather than breaks down.
 */
export function trackEnergy(phrases: readonly Phrase[]): number {
  let bars = 0;
  let drive = 0;
  for (const phrase of phrases) {
    bars += phrase.bars;
    if (phrase.hasKick) drive += phrase.bars * (phrase.hasBass ? 1 : KICK_ONLY_DRIVE);
  }
  return bars > 0 ? drive / bars : UNKNOWN_ENERGY;
}

export function sequencerTrackFromAnalysis(id: string, analysis: AudioAnalysis): SequencerTrack {
  const { tonic, mode, confidence } = analysis.key;
  return { id, bpm: analysis.bpm, key: { tonic, mode, confidence }, energy: trackEnergy(analysis.phrases) };
}

/**
 * How good a hand-over from `from` to `to` is. `fromKeyShift` is the shift the outgoing track
 * already plays with: a shift lasts the whole track, so the next match is made against it.
 */
export function transitionScore(
  from: SequencerTrack,
  to: SequencerTrack,
  options: Partial<SequencerOptions> = {},
  fromKeyShift = 0,
): TransitionScore {
  return scoreTransition(from, to, resolveOptions(options), fromKeyShift);
}

export interface Suggestion {
  track: SequencerTrack;
  transition: TransitionScore;
}

/** Best tracks to play after `current`, best first. */
export function suggestNext(
  current: SequencerTrack,
  candidates: readonly SequencerTrack[],
  options: Partial<SequencerOptions> = {},
  count = 5,
  currentKeyShift = 0,
): Suggestion[] {
  const resolved = resolveOptions(options);
  return candidates
    .filter((track) => track.id !== current.id)
    .map((track) => ({ track, transition: scoreTransition(current, track, resolved, currentKeyShift) }))
    .sort((a, b) => b.transition.score - a.transition.score || compareIds(a.track.id, b.track.id))
    .slice(0, Math.max(0, count));
}

export interface OrderSetOptions extends Partial<SequencerOptions> {
  /** Track the set must open with, e.g. the one playing now. */
  startId?: string;
  /** Partial orders kept per step: wider finds better orders, more slowly. */
  beamWidth?: number;
}

export interface SetOrder {
  tracks: SequencerTrack[];
  /** `transitions[i]` takes `tracks[i]` into `tracks[i + 1]`, including that track's key shift. */
  transitions: TransitionScore[];
  /** Sum of the transition scores. */
  score: number;
}

interface BeamNode {
  /** Last track, as an index into the id-sorted list. */
  index: number;
  keyShift: number;
  used: bigint;
  /** Sum of the transitions so far. */
  score: number;
  /** `score` less the expected cost of returning to tracks left behind; the beam ranks by it. */
  rank: number;
  parent: BeamNode | null;
}

/**
 * Orders the whole set for the best summed transition score with a beam search. Equivalent
 * partial orders (same tracks used, same last track and shift) are merged, and paths that leave
 * tracks behind the set's direction are ranked down by the step back they will need, so the beam
 * doesn't fill with orders that skip ahead and must fall back later.
 */
export function orderSet(tracks: readonly SequencerTrack[], options: OrderSetOptions = {}): SetOrder {
  const resolved = resolveOptions(options);
  const width = Math.max(1, Math.floor(options.beamWidth ?? DEFAULT_BEAM_WIDTH));
  // Sorting by id first makes the result depend on the set, not on the order it arrived in.
  const sorted = [...tracks].sort((a, b) => compareIds(a.id, b.id));
  const n = sorted.length;
  if (n === 0) return { tracks: [], transitions: [], score: 0 };

  let starts = sorted.map((_, i) => i);
  if (options.startId !== undefined) {
    const start = sorted.findIndex((track) => track.id === options.startId);
    if (start < 0) throw new Error(`orderSet: no track with id ${options.startId}`);
    starts = [start];
  }

  const bits = sorted.map((_, i) => 1n << BigInt(i));
  const shiftSlots = 2 * MAX_KEY_SHIFT + 1;
  const cache: (TransitionScore | undefined)[] = new Array(n * shiftSlots * n);
  const transition = (from: number, fromShift: number, to: number): TransitionScore =>
    (cache[(from * shiftSlots + fromShift + MAX_KEY_SHIFT) * n + to] ??= scoreTransition(
      sorted[from],
      sorted[to],
      resolved,
      fromShift,
    ));

  /** Unused track furthest behind the direction, and the runner-up for when the first is taken next. */
  const furthestBehind = (used: bigint): [number, number] => {
    let first = -1;
    let second = -1;
    if (resolved.direction === 'any') return [first, second];
    const sign = resolved.direction === 'up' ? 1 : -1;
    for (let i = 0; i < n; i++) {
      if ((used & bits[i]) !== 0n) continue;
      if (first < 0 || sign * sorted[i].bpm < sign * sorted[first].bpm) {
        second = first;
        first = i;
      } else if (second < 0 || sign * sorted[i].bpm < sign * sorted[second].bpm) {
        second = i;
      }
    }
    return [first, second];
  };
  const behindCost = (current: number, behind: number) =>
    behind < 0 ? 0 : leftBehindCost(sorted[current].bpm, sorted[behind].bpm, resolved.direction);

  let beam: BeamNode[] = starts.map((index) => {
    const [first] = furthestBehind(bits[index]);
    return { index, keyShift: 0, used: bits[index], score: 0, rank: -behindCost(index, first), parent: null };
  });

  for (let step = 1; step < n; step++) {
    const candidates: BeamNode[] = [];
    for (const node of beam) {
      const [first, second] = furthestBehind(node.used);
      for (let next = 0; next < n; next++) {
        if ((node.used & bits[next]) !== 0n) continue;
        const hop = transition(node.index, node.keyShift, next);
        const score = node.score + hop.score;
        candidates.push({
          index: next,
          keyShift: hop.keyShift,
          used: node.used | bits[next],
          score,
          rank: score - behindCost(next, next === first ? second : first),
          parent: node,
        });
      }
    }
    beam = prune(candidates, width);
  }

  const best = beam.reduce((a, b) => (b.score > a.score ? b : a));
  const indices: number[] = [];
  for (let node: BeamNode | null = best; node; node = node.parent) indices.push(node.index);
  indices.reverse();

  const transitions: TransitionScore[] = [];
  let shift = 0;
  for (let i = 1; i < n; i++) {
    const hop = transition(indices[i - 1], shift, indices[i]);
    transitions.push(hop);
    shift = hop.keyShift;
  }
  return { tracks: indices.map((i) => sorted[i]), transitions, score: best.score };
}

function scoreTransition(
  from: SequencerTrack,
  to: SequencerTrack,
  options: SequencerOptions,
  fromKeyShift: number,
): TransitionScore {
  const plan = planTempo(from.bpm, 1, to.bpm, options.tempoPolicy);
  const tempo = tempoFit(plan, options.tempoPolicy);
  const direction = directionFit(Math.log(to.bpm / from.bpm), options.direction);
  const { harmonic, keyShift } = harmonicFit(from, fromKeyShift, to, options);
  const energy = energyFit(from.energy, to.energy, options.direction);
  return {
    score:
      TEMPO_WEIGHT * tempo + DIRECTION_WEIGHT * direction + HARMONIC_WEIGHT * harmonic + ENERGY_WEIGHT * energy,
    canBlend: plan.canBlend,
    tempo,
    direction,
    harmonic,
    energy,
    keyShift,
  };
}

/** Total distance both tracks are pulled off their own tempo, against the widest bridgeable gap. */
function tempoFit(plan: TempoPlan, policy: TempoPolicy): number {
  if (!plan.canBlend) return NO_BLEND_SCORE;
  const stretch = Math.abs(Math.log(plan.outgoingRate)) + Math.abs(Math.log(plan.incomingRate));
  const widestGap = Math.log((1 + policy.maxDeviation) / (1 - policy.maxDeviation));
  return 1 - stretch / widestGap;
}

/** `step` is the log tempo ratio; gradual steps along the direction score 1, steps back fall without limit. */
function directionFit(step: number, direction: TempoDirection): number {
  const along = direction === 'up' ? step : direction === 'down' ? -step : Math.abs(step);
  if (along < 0) return 1 + along / AGAINST_STEP;
  return Math.max(LEAP_FLOOR, 1 - Math.max(0, along - GRADUAL_STEP) / GRADUAL_STEP);
}

/** Expected direction cost of stepping back to a track the set left behind. */
function leftBehindCost(currentBpm: number, behindBpm: number, direction: TempoDirection): number {
  if (direction === 'any') return 0;
  const back = direction === 'up' ? Math.log(currentBpm / behindBpm) : Math.log(behindBpm / currentBpm);
  return back > 0 ? (LEFT_BEHIND_FACTOR * DIRECTION_WEIGHT * back) / AGAINST_STEP : 0;
}

function harmonicFit(
  from: SequencerTrack,
  fromKeyShift: number,
  to: SequencerTrack,
  options: SequencerOptions,
): { harmonic: number; keyShift: number } {
  const fromKey = transpose(from.key, fromKeyShift);
  const confident =
    Math.min(from.key.confidence ?? 0, to.key.confidence ?? 0) >= options.minKeyShiftConfidence;
  if (!options.allowKeyShift || !confident) return { harmonic: harmonicScore(fromKey, to.key), keyShift: 0 };
  const best = bestKeyShift(fromKey, to.key, MAX_KEY_SHIFT);
  return { harmonic: best.semitones === 0 ? best.score : best.score - KEY_SHIFT_COST, keyShift: best.semitones };
}

/** A gentle rise along the set's arc scores best ('down' sets wind energy down instead). */
function energyFit(fromEnergy: number, toEnergy: number, direction: TempoDirection): number {
  const rise = direction === 'down' ? fromEnergy - toEnergy : toEnergy - fromEnergy;
  const offset = rise - IDEAL_ENERGY_STEP;
  return Math.max(-1, offset >= 0 ? 1 - offset / ENERGY_JUMP : 1 + offset / ENERGY_FALL);
}

/** Best `width` distinct partial orders, best first; generation order breaks ties, so it's deterministic. */
function prune(candidates: BeamNode[], width: number): BeamNode[] {
  candidates.sort((a, b) => b.rank - a.rank);
  const kept: BeamNode[] = [];
  const seen = new Set<string>();
  for (const node of candidates) {
    const key = `${node.index}:${node.keyShift}:${node.used}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(node);
    if (kept.length === width) break;
  }
  return kept;
}

function resolveOptions(options: Partial<SequencerOptions>): SequencerOptions {
  return { ...DEFAULT_SEQUENCER_OPTIONS, ...options };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
