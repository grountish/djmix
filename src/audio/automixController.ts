import type { AudioAnalysis } from './analysis/types';
import { getMixGraph } from './engine/liveGraph';
import type { DeckId } from './engine/mixGraph';
import type { MixTiming } from './mix/mixPoints';
import { planTransition, type PlanPolicy, type TransitionPlan } from './mix/planner';
import { type LaneValues, TransitionRunner } from './mix/runner';
import { trackClock } from './mix/trackClock';
import { getDeckPlayer, trackDeckTime } from './playbackEngine';

export interface AutomixCallbacks {
  /** The incoming deck became audible. */
  onIncomingStarted: () => void;
  onOutgoingStopped: () => void;
  onFinished: () => void;
  /**
   * Each tick: every deck's playback rate, where the automated controls stand, and seconds
   * until the incoming deck is heard (negative once it is).
   */
  onTick?: (rates: Record<DeckId, number>, lanes: LaneValues, secondsToStart: number) => void;
}

/** Dispatch tick; timers keep running while the window is hidden (Electron throttling off). */
const DISPATCH_INTERVAL_MS = 30;

let planPolicy: Partial<PlanPolicy> = {};

/** Overrides for every plan made from now on (e.g. a shorter maximum blend); {} resets. */
export function setPlanPolicy(policy: Partial<PlanPolicy>): void {
  planPolicy = policy;
}

let active: {
  runner: TransitionRunner;
  timer: ReturnType<typeof setInterval>;
  incomingId: DeckId;
} | null = null;

/** One transition that ran (or runs), for diagnosis after the fact. */
export interface TransitionRecord {
  plan: TransitionPlan;
  outgoingId: DeckId;
  incomingId: DeckId;
  timing: MixTiming;
  /** Audio-clock times: when it was started, when the incoming deck is/was heard, when it ended. */
  startedAt: number;
  incomingStart: number;
  overlapEnd: number;
  /** 'cancelled' when the user took over, 'finished' when it ran to the end; absent while running. */
  outcome?: 'finished' | 'cancelled';
  endedAt?: number;
  lockAbandoned: boolean;
}

const HISTORY_LENGTH = 4;
const history: TransitionRecord[] = [];
const runnerClosers = new WeakMap<TransitionRunner, (outcome: 'finished' | 'cancelled') => void>();

/** The last few transitions, newest first (the running one included). */
export function recentTransitions(): TransitionRecord[] {
  return [...history].reverse();
}

function remember(record: TransitionRecord): void {
  history.push(record);
  if (history.length > HISTORY_LENGTH) history.shift();
}

/**
 * The transition that would run now from the playing `outgoingId` deck into the other deck:
 * tempo meeting point, phrase-aligned mix points, key shift and EQ blend. Pass the analyses
 * with the user's corrections applied. Null when the outgoing deck isn't playing.
 */
export function previewTransition(
  outgoingId: DeckId,
  outgoing: AudioAnalysis,
  incoming: AudioAnalysis,
  timing: MixTiming = 'end',
  startBar?: number,
): TransitionPlan | null {
  const player = getDeckPlayer(outgoingId);
  if (!player.isPlaying) return null;
  const incomingId: DeckId = outgoingId === 'A' ? 'B' : 'A';
  return planTransition({
    outgoing: {
      analysis: outgoing,
      trackTime: player.currentTime(),
      rate: player.currentRate,
      semitones: player.keyShift,
      trimDb: deckTrimDb(outgoingId),
    },
    incoming: { analysis: incoming, trimDb: deckTrimDb(incomingId) },
    timing,
    startBar,
    policy: planPolicy,
  });
}

/** The trim a deck plays with right now (auto trim plus the gain knob), read off its input gain. */
function deckTrimDb(id: DeckId): number {
  const gain = getMixGraph().decks[id].input.gain.value;
  return gain > 0 ? 20 * Math.log10(gain) : -60;
}

/** Seconds until the plan's outgoing tempo ramp (its first audible change) begins. */
export function secondsUntilPlan(outgoingId: DeckId, outgoing: AudioAnalysis, plan: TransitionPlan): number {
  return secondsUntilBar(outgoingId, outgoing, plan.outgoingRampStartBar);
}

/** Seconds until the incoming track is heard: the overlap starts. */
export function secondsUntilOverlap(outgoingId: DeckId, outgoing: AudioAnalysis, plan: TransitionPlan): number {
  return secondsUntilBar(outgoingId, outgoing, plan.outgoingStartBar);
}

function secondsUntilBar(outgoingId: DeckId, outgoing: AudioAnalysis, bar: number): number {
  const player = getDeckPlayer(outgoingId);
  return (trackClock(outgoing).timeOf(bar * 4) - player.currentTime()) / player.currentRate;
}

/** m:ss, never negative. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Plans and starts a transition (see previewTransition) on the audio clock. Returns the plan,
 * or null when the decks aren't ready.
 */
export function startAutomixTransition(
  outgoingId: DeckId,
  outgoing: AudioAnalysis,
  incoming: AudioAnalysis,
  timing: MixTiming,
  callbacks: AutomixCallbacks,
  startBar?: number,
): TransitionPlan | null {
  cancelTransition();
  const incomingId: DeckId = outgoingId === 'A' ? 'B' : 'A';
  const outgoingPlayer = getDeckPlayer(outgoingId);
  const incomingPlayer = getDeckPlayer(incomingId);
  if (!incomingPlayer.audioBuffer) return null;
  const plan = previewTransition(outgoingId, outgoing, incoming, timing, startBar);
  if (!plan) return null;

  const graph = getMixGraph();
  const runner = new TransitionRunner(
    graph.ctx,
    graph,
    { id: outgoingId, player: outgoingPlayer, clock: trackClock(outgoing) },
    { id: incomingId, player: incomingPlayer, clock: trackClock(incoming) },
    plan,
    {
      onIncomingStarted: () => {
        trackDeckTime(incomingId);
        callbacks.onIncomingStarted();
      },
      onOutgoingStopped: callbacks.onOutgoingStopped,
      onFinished: () => {
        runnerClosers.get(runner)?.('finished');
        stopTimer();
        callbacks.onFinished();
      },
    },
  );
  runner.start();
  if (runner.lockAbandoned) {
    plan.warnings.push('Beat clocks disagree: not beat-locked');
    console.warn('[automix] beat lock abandoned: the two beat clocks disagree by more than 3%');
  }
  const record: TransitionRecord = {
    plan,
    outgoingId,
    incomingId,
    timing,
    startedAt: graph.ctx.currentTime,
    incomingStart: runner.incomingStart,
    overlapEnd: runner.overlapEnd,
    lockAbandoned: runner.lockAbandoned,
  };
  remember(record);
  const close = (outcome: 'finished' | 'cancelled') => {
    if (!record.outcome) {
      record.outcome = outcome;
      record.endedAt = graph.ctx.currentTime;
    }
  };
  runnerClosers.set(runner, close);

  const timer = setInterval(() => {
    const now = graph.ctx.currentTime;
    runner.dispatch(now);
    callbacks.onTick?.(
      { A: getDeckPlayer('A').currentRate, B: getDeckPlayer('B').currentRate },
      runner.laneValues(now),
      runner.incomingStart - now,
    );
  }, DISPATCH_INTERVAL_MS);
  active = { runner, timer, incomingId };
  return plan;
}

function stopTimer(): void {
  if (active) clearInterval(active.timer);
  active = null;
}

/**
 * Stops a running transition where it is. Returns which deck was coming in and whether it
 * was audible yet (null when nothing ran); the caller restores the controls.
 */
export function cancelTransition(): { incomingId: DeckId; incomingStarted: boolean } | null {
  if (!active) return null;
  const { runner, incomingId } = active;
  runner.cancel();
  runnerClosers.get(runner)?.('cancelled');
  stopTimer();
  return { incomingId, incomingStarted: runner.incomingStarted(getMixGraph().ctx.currentTime) };
}

/** The plan in one line, without a lead-in: "32-bar blend at bar 97, … · 124.0 BPM · 8A→8A". */
export function describePlan(plan: TransitionPlan): string {
  const tempo = `${plan.tempo.meetBpm.toFixed(1)} BPM`;
  const keys = `${plan.harmonic.outgoingKey}→${plan.harmonic.incomingKey}`;
  const shift = plan.incomingSemitones ? ` (${plan.incomingSemitones > 0 ? '+' : ''}${plan.incomingSemitones} st)` : '';
  const loop = plan.outgoingLoop ? `, looping bars ${plan.outgoingLoop.startBar + 1}–${plan.outgoingLoop.startBar + plan.outgoingLoop.bars}` : '';
  const what =
    plan.kind === 'blend'
      ? `${plan.overlapBars}-bar blend at bar ${plan.outgoingStartBar + 1}, next track in from its bar ${plan.incomingStartBar + 1}, bass swap at bar ${plan.outgoingStartBar + plan.bassSwapBar + 1}${loop}`
      : `cut at bar ${plan.outgoingStartBar + 1} into bar ${plan.incomingStartBar + 1}`;
  const warnings = plan.warnings.length ? ` · ⚠ ${plan.warnings.join('; ')}` : '';
  return `${what} · ${tempo} · ${keys}${shift}${warnings}`;
}
