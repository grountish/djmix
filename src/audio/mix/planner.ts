import { toCamelot, type MusicalKey } from '../analysis/key';
import type { AudioAnalysis, TrackKey } from '../analysis/types';
import { loudnessTrimDb } from '../engine/curves';
import { balancePlan, type BalanceReport } from './balance';
import { bestKeyShift, harmonicScore, MIN_KEY_SHIFT_CONFIDENCE, transpose } from './harmonic';
import { chooseMixPoints, type IncomingLoop, type MixStyle, type MixTiming, type OutgoingLoop } from './mixPoints';
import { DEFAULT_TEMPO_POLICY, planTempo, type TempoPlan, type TempoPolicy } from './tempoPlan';
import { blendTemplate, cutTemplate, type Lane } from './templates';
import { trackClock } from './trackClock';

export interface PlanPolicy {
  tempo: TempoPolicy;
  maxOverlapBars: number;
  /** Shift the incoming track by up to a semitone when that fixes a key clash. */
  allowKeyShift: boolean;
  /** Detected keys below this confidence are not trusted for shifting (tags count as 1). */
  minKeyConfidence: number;
  /** Balance the blend's EQ lanes on the two tracks' band energies (see `balance.ts`). */
  balance: boolean;
}

export const DEFAULT_PLAN_POLICY: PlanPolicy = {
  tempo: DEFAULT_TEMPO_POLICY,
  maxOverlapBars: 32,
  // Keys are shown and warned about, but never change how a blend is played.
  allowKeyShift: false,
  minKeyConfidence: MIN_KEY_SHIFT_CONFIDENCE,
  balance: true,
};

/** Compatibility below this is reported as a clash. */
const KEY_CLASH_SCORE = 0.5;
/** Bars of lead time on top of the tempo ramp, so everything can be scheduled ahead. */
const SCHEDULING_LEAD_BARS = 1;

export interface PlanInput {
  outgoing: {
    analysis: AudioAnalysis;
    /** Tempo the analysis is read at (a manual correction may differ from analysis.bpm). */
    bpm?: number;
    /** Where the outgoing deck is now, in track seconds, and how fast it plays. */
    trackTime: number;
    rate: number;
    /** Pitch shift it already plays with. */
    semitones: number;
    /** Trim the deck plays with, dB (auto trim plus any gain knob); the auto trim when absent. */
    trimDb?: number;
  };
  incoming: { analysis: AudioAnalysis; bpm?: number; trimDb?: number };
  /** 'end' (default): where the outgoing track runs out. 'now': the next 16/32-bar entry. */
  timing?: MixTiming;
  /** The user's choice of outgoing bar for the overlap to start on (see MixPointInput). */
  startBar?: number;
  /** 'blend' (default) or 'loop' (see MixStyle). */
  style?: MixStyle;
  policy?: Partial<PlanPolicy>;
}

/** A transition in musical time: bars of each track, independent of the audio clock. */
export interface TransitionPlan {
  kind: 'blend' | 'cut';
  tempo: TempoPlan;
  overlapBars: number;
  /** Outgoing bar where the incoming track enters (the overlap starts). */
  outgoingStartBar: number;
  /** Outgoing bar where its tempo ramp towards the meeting tempo begins. */
  outgoingRampStartBar: number;
  /** Incoming bar playing when the overlap starts. */
  incomingStartBar: number;
  bassSwapBar: number;
  /**
   * A phrase the outgoing track repeats until it is stopped, when it hasn't the bars left for
   * the blend; outgoing bars above count along the looped timeline.
   */
  outgoingLoop?: OutgoingLoop;
  /**
   * A sparse intro phrase the incoming track repeats while it fades in (loop style); incoming
   * bars of the overlap count along the looped timeline, the cue is before it.
   */
  incomingLoop?: IncomingLoop;
  /** Key-lock pitch shift for the incoming track. */
  incomingSemitones: number;
  harmonic: { score: number; outgoingKey: string; incomingKey: string };
  lanes: Lane[];
  /** Forecast of the blend's band levels, when the lanes were balanced on them. */
  balance?: BalanceReport;
  warnings: string[];
}

export function planTransition(input: PlanInput): TransitionPlan {
  const policy = { ...DEFAULT_PLAN_POLICY, ...input.policy };
  const outgoingBpm = input.outgoing.bpm ?? input.outgoing.analysis.bpm;
  const incomingBpm = input.incoming.bpm ?? input.incoming.analysis.bpm;
  const out = input.outgoing.analysis;
  const inc = input.incoming.analysis;

  const tempo = planTempo(outgoingBpm, input.outgoing.rate, incomingBpm, policy.tempo);

  const outgoingKey = transpose(out.key, input.outgoing.semitones);
  const shift = chooseKeyShift(outgoingKey, out.key, inc.key, policy);
  const incomingKey = transpose(inc.key, shift);
  const score = harmonicScore(outgoingKey, incomingKey);
  const keyClash = score < KEY_CLASH_SCORE;

  const currentBar = trackClock(out, outgoingBpm).beatAt(input.outgoing.trackTime) / 4;
  // Low-band levels as the decks will play them, so the swap can avoid a bass hole.
  const trims = {
    outgoing: input.outgoing.trimDb ?? loudnessTrimDb(out.loudness.integratedLufs),
    incoming: input.incoming.trimDb ?? loudnessTrimDb(inc.loudness.integratedLufs),
  };
  const trimmedLow = (analysis: AudioAnalysis, trim: number) => analysis.bars.lowDb.map((db) => db + trim);
  const points = chooseMixPoints({
    outgoing: { phrases: out.phrases, barCount: out.bars.lowDb.length, lowDb: trimmedLow(out, trims.outgoing), currentBar },
    incoming: { phrases: inc.phrases, barCount: inc.bars.lowDb.length, lowDb: trimmedLow(inc, trims.incoming) },
    leadBars: tempo.outgoingRampBars + SCHEDULING_LEAD_BARS,
    maxOverlapBars: tempo.canBlend ? policy.maxOverlapBars : 0,
    timing: input.timing,
    startBar: input.startBar,
    style: input.style,
  });

  const blend = tempo.canBlend && points.overlapBars > 0;
  const warnings: string[] = [];
  if (!tempo.canBlend) warnings.push(`Tempos too far apart to blend (${outgoingBpm.toFixed(1)} → ${incomingBpm.toFixed(1)} BPM)`);
  if (keyClash) warnings.push(`Keys clash (${toCamelot(outgoingKey)} → ${toCamelot(incomingKey)})`);
  for (const [name, analysis] of [['Outgoing', out], ['Incoming', inc]] as const) {
    if (!analysis.tempo.isConstant) warnings.push(`${name} track's tempo drifts`);
    if (analysis.downbeatConfidence < 0.2) warnings.push(`${name} track's downbeat is uncertain`);
  }
  if (input.style === 'loop' && blend && !points.incomingLoop) warnings.push('No intro loop fits: a plain blend');

  const plan: TransitionPlan = {
    kind: blend ? 'blend' : 'cut',
    tempo: blend ? tempo : { ...tempo, incomingRate: 1, incomingRampBars: 0, outgoingRate: input.outgoing.rate, outgoingRampBars: 0 },
    overlapBars: blend ? points.overlapBars : 0,
    outgoingStartBar: points.outgoingStartBar,
    outgoingRampStartBar: points.outgoingStartBar - (blend ? tempo.outgoingRampBars : 0),
    incomingStartBar: points.incomingStartBar,
    bassSwapBar: points.bassSwapBar,
    ...(blend && points.outgoingLoop ? { outgoingLoop: points.outgoingLoop } : {}),
    ...(blend && points.incomingLoop ? { incomingLoop: points.incomingLoop } : {}),
    incomingSemitones: shift,
    harmonic: { score, outgoingKey: toCamelot(outgoingKey), incomingKey: toCamelot(incomingKey) },
    lanes: blend ? blendTemplate(points.overlapBars, points.bassSwapBar) : cutTemplate(),
    warnings,
  };
  return policy.balance ? balancePlan(plan, out, inc, trims) : plan;
}

/** ±1 semitone on the incoming track when it turns a clash into a match and both keys are trusted. */
function chooseKeyShift(
  outgoingKey: MusicalKey,
  outgoingTrackKey: TrackKey,
  incomingTrackKey: TrackKey,
  policy: PlanPolicy,
): number {
  if (!policy.allowKeyShift) return 0;
  const trusted = (key: TrackKey) => key.source === 'tag' || key.confidence >= policy.minKeyConfidence;
  if (!trusted(outgoingTrackKey) || !trusted(incomingTrackKey)) return 0;
  return bestKeyShift(outgoingKey, incomingTrackKey, 1).semitones;
}
