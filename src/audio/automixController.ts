import type { TrackAnalysis } from '@/types';
import { getMixGraph } from './engine/liveGraph';
import type { DeckId } from './engine/mixGraph';
import { planTransition, type TransitionPlan } from './mix/planner';
import { TransitionRunner } from './mix/runner';
import { trackClock } from './mix/trackClock';
import { getDeckPlayer, trackDeckTime } from './playbackEngine';

export interface AutomixCallbacks {
  onOutgoingStopped: () => void;
  onFinished: () => void;
  /** Each tick, with every deck's current playback rate (for the UI). */
  onTick?: (rates: Record<DeckId, number>) => void;
}

/** Dispatch tick; timers keep running while the window is hidden (Electron throttling off). */
const DISPATCH_INTERVAL_MS = 30;

let active: { runner: TransitionRunner; timer: ReturnType<typeof setInterval> } | null = null;

/** Tempo the analysis is read at: a manual BPM correction wins. */
function readBpm(analysis: TrackAnalysis): number {
  return analysis.manualBpm ?? analysis.bpm;
}

/**
 * Plans and starts a transition from the playing `outgoingId` deck into the other deck: tempo
 * meeting point, phrase-aligned mix points, key shift and EQ blend, all on the audio clock.
 * Returns the plan, or null when the decks aren't ready.
 */
export function startAutomixTransition(
  outgoingId: DeckId,
  outgoing: TrackAnalysis,
  incoming: TrackAnalysis,
  callbacks: AutomixCallbacks,
): TransitionPlan | null {
  cancelTransition();
  const incomingId: DeckId = outgoingId === 'A' ? 'B' : 'A';
  const outgoingPlayer = getDeckPlayer(outgoingId);
  const incomingPlayer = getDeckPlayer(incomingId);
  if (!outgoingPlayer.isPlaying || !incomingPlayer.audioBuffer) return null;

  const plan = planTransition({
    outgoing: {
      analysis: outgoing,
      bpm: readBpm(outgoing),
      trackTime: outgoingPlayer.currentTime(),
      rate: outgoingPlayer.currentRate,
      semitones: outgoingPlayer.keyShift,
    },
    incoming: { analysis: incoming, bpm: readBpm(incoming) },
  });

  const graph = getMixGraph();
  const runner = new TransitionRunner(
    graph.ctx,
    graph,
    { id: outgoingId, player: outgoingPlayer, clock: trackClock(outgoing, readBpm(outgoing)) },
    { id: incomingId, player: incomingPlayer, clock: trackClock(incoming, readBpm(incoming)) },
    plan,
    {
      onOutgoingStopped: callbacks.onOutgoingStopped,
      onFinished: () => {
        stopTimer();
        callbacks.onFinished();
      },
    },
  );
  runner.start();
  trackDeckTime(incomingId);

  const timer = setInterval(() => {
    runner.dispatch(graph.ctx.currentTime);
    callbacks.onTick?.({ A: getDeckPlayer('A').currentRate, B: getDeckPlayer('B').currentRate });
  }, DISPATCH_INTERVAL_MS);
  active = { runner, timer };
  return plan;
}

function stopTimer(): void {
  if (active) clearInterval(active.timer);
  active = null;
}

/** Stops a running transition where it is (both decks keep playing). Returns true if one ran. */
export function cancelTransition(): boolean {
  if (!active) return false;
  active.runner.cancel();
  stopTimer();
  return true;
}

/** One line for the status bar. */
export function describePlan(plan: TransitionPlan): string {
  const tempo = `${plan.tempo.meetBpm.toFixed(1)} BPM`;
  const keys = `${plan.harmonic.outgoingKey}→${plan.harmonic.incomingKey}`;
  const shift = plan.incomingSemitones ? ` (${plan.incomingSemitones > 0 ? '+' : ''}${plan.incomingSemitones} st)` : '';
  const what =
    plan.kind === 'blend'
      ? `${plan.overlapBars}-bar blend at bar ${plan.outgoingStartBar + 1}, bass swap at bar ${plan.outgoingStartBar + plan.bassSwapBar + 1}`
      : `cut at bar ${plan.outgoingStartBar + 1}`;
  const warnings = plan.warnings.length ? ` · ⚠ ${plan.warnings.join('; ')}` : '';
  return `Mix: ${what} · ${tempo} · ${keys}${shift}${warnings}`;
}
