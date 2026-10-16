import type { DeckState } from '@/types';
import { getAudioContext } from './decoder';
import { clamp } from './engine/curves';
import type { DeckId } from './engine/mixGraph';
import { STRETCH_LEAD } from './engine/stretch';
import { type BeatGrid, nextBarOnClock, type PlayheadAnchor } from './engine/transport';
import { scheduleCrossfade } from './mixingEngine';

export interface TransitionCallbacks {
  onSyncBpm: (deck: DeckId) => void;
  /** Where a playing deck's playhead sits on the audio clock. */
  getAnchor: (deck: DeckId) => PlayheadAnchor | null;
  onSeek: (deck: DeckId, time: number) => void;
  /** Start the deck exactly at audio-clock time `when`. */
  onStartPlay: (deck: DeckId, when: number) => void;
  /** UI only: the audio clock already automates the crossfader. */
  onCrossfaderDisplay: (value: number) => void;
  onStopDeck: (deck: DeckId) => void;
  onTransitionComplete: () => void;
}

/** Keeps the scheduled start safely ahead of the audio thread and the key-lock stretcher. */
const MIN_SCHEDULE_LEAD = STRETCH_LEAD + 0.1;

/** UI refresh and completion check; timers keep running while the window is hidden. */
const MONITOR_INTERVAL_MS = 30;

let monitorTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Beat-synced transition: the next deck starts exactly on the current deck's next bar line
 * and the crossfade runs on the audio clock. Returns false when the transition can't start.
 */
export function triggerTransition(
  currentDeckId: DeckId,
  currentDeckState: DeckState,
  nextDeckState: DeckState,
  callbacks: TransitionCallbacks,
  crossfadeDuration: number = 8,
): boolean {
  cancelTransition();

  const currentAnalysis = currentDeckState.track?.analysis;
  const nextAnalysis = nextDeckState.track?.analysis;
  const nextDeckId: DeckId = currentDeckId === 'A' ? 'B' : 'A';

  if (!currentAnalysis || !nextAnalysis) {
    console.log('Automix: Both tracks need analysis for transition');
    return false;
  }

  // Sync BPM of the next deck to current
  callbacks.onSyncBpm(nextDeckId);

  const anchor = callbacks.getAnchor(currentDeckId);
  if (!anchor) {
    console.log('Automix: Current deck is not playing');
    return false;
  }

  const ctx = getAudioContext();
  const grid: BeatGrid = {
    bpm: currentAnalysis.manualBpm || currentAnalysis.bpm,
    firstBeatTime: currentAnalysis.firstBeatTime || 0,
  };
  const start = nextBarOnClock(anchor, grid, ctx.currentTime, MIN_SCHEDULE_LEAD);

  callbacks.onSeek(nextDeckId, nextAnalysis.firstBeatTime || 0);
  callbacks.onStartPlay(nextDeckId, start.ctxTime);

  const from = currentDeckId === 'A' ? -1 : 1;
  const to = -from;
  scheduleCrossfade(from, to, start.ctxTime, crossfadeDuration);

  const endTime = start.ctxTime + crossfadeDuration;
  monitorTimer = setInterval(() => {
    const now = ctx.currentTime;
    const progress = clamp((now - start.ctxTime) / crossfadeDuration, 0, 1);
    callbacks.onCrossfaderDisplay(from + (to - from) * progress);

    if (now >= endTime) {
      cancelTransition();
      callbacks.onStopDeck(currentDeckId);
      callbacks.onTransitionComplete();
    }
  }, MONITOR_INTERVAL_MS);

  return true;
}

/** Stops tracking a running transition. Returns true if one was running. */
export function cancelTransition(): boolean {
  if (monitorTimer === null) return false;
  clearInterval(monitorTimer);
  monitorTimer = null;
  return true;
}
