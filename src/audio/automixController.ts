import type { AudioAnalysis } from './analysis/types';
import { getMixGraph } from './engine/liveGraph';
import type { DeckId } from './engine/mixGraph';
import type { MixTiming } from './mix/mixPoints';
import { planTransition, type TransitionPlan } from './mix/planner';
import { type LaneValues, TransitionRunner } from './mix/runner';
import { trackClock } from './mix/trackClock';
import { getDeckPlayer, trackDeckTime } from './playbackEngine';

export interface AutomixCallbacks {
  /** The incoming deck became audible. */
  onIncomingStarted: () => void;
  onOutgoingStopped: () => void;
  onFinished: () => void;
  /** Each tick: every deck's playback rate and where the automated controls stand. */
  onTick?: (rates: Record<DeckId, number>, lanes: LaneValues) => void;
}

/** Dispatch tick; timers keep running while the window is hidden (Electron throttling off). */
const DISPATCH_INTERVAL_MS = 30;

let active: {
  runner: TransitionRunner;
  timer: ReturnType<typeof setInterval>;
  incomingId: DeckId;
} | null = null;

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
): TransitionPlan | null {
  const player = getDeckPlayer(outgoingId);
  if (!player.isPlaying) return null;
  return planTransition({
    outgoing: {
      analysis: outgoing,
      trackTime: player.currentTime(),
      rate: player.currentRate,
      semitones: player.keyShift,
    },
    incoming: { analysis: incoming },
    timing,
  });
}

/** Seconds until the plan's outgoing tempo ramp (its first audible change) begins. */
export function secondsUntilPlan(outgoingId: DeckId, outgoing: AudioAnalysis, plan: TransitionPlan): number {
  const player = getDeckPlayer(outgoingId);
  const rampStart = trackClock(outgoing).timeOf(plan.outgoingRampStartBar * 4);
  return (rampStart - player.currentTime()) / player.currentRate;
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
): TransitionPlan | null {
  cancelTransition();
  const incomingId: DeckId = outgoingId === 'A' ? 'B' : 'A';
  const outgoingPlayer = getDeckPlayer(outgoingId);
  const incomingPlayer = getDeckPlayer(incomingId);
  if (!incomingPlayer.audioBuffer) return null;
  const plan = previewTransition(outgoingId, outgoing, incoming, timing);
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

  const timer = setInterval(() => {
    const now = graph.ctx.currentTime;
    runner.dispatch(now);
    callbacks.onTick?.(
      { A: getDeckPlayer('A').currentRate, B: getDeckPlayer('B').currentRate },
      runner.laneValues(now),
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
  stopTimer();
  return { incomingId, incomingStarted: runner.incomingStarted(getMixGraph().ctx.currentTime) };
}

/** One line for the status bar. */
export function describePlan(plan: TransitionPlan): string {
  const tempo = `${plan.tempo.meetBpm.toFixed(1)} BPM`;
  const keys = `${plan.harmonic.outgoingKey}→${plan.harmonic.incomingKey}`;
  const shift = plan.incomingSemitones ? ` (${plan.incomingSemitones > 0 ? '+' : ''}${plan.incomingSemitones} st)` : '';
  const what =
    plan.kind === 'blend'
      ? `${plan.overlapBars}-bar blend at bar ${plan.outgoingStartBar + 1}, next track in from its bar ${plan.incomingStartBar + 1}, bass swap at bar ${plan.outgoingStartBar + plan.bassSwapBar + 1}`
      : `cut at bar ${plan.outgoingStartBar + 1} into bar ${plan.incomingStartBar + 1}`;
  const warnings = plan.warnings.length ? ` · ⚠ ${plan.warnings.join('; ')}` : '';
  return `Mix: ${what} · ${tempo} · ${keys}${shift}${warnings}`;
}
