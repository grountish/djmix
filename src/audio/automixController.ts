import type { Track, DeckState } from '@/types';
import { getDeckCurrentTime } from './playbackEngine';

export interface TransitionCallbacks {
  onSyncBpm: (deck: 'A' | 'B') => void;
  onStartPlay: (deck: 'A' | 'B') => void;
  onStopDeck: (deck: 'A' | 'B') => void;
  onSeek: (deck: 'A' | 'B', time: number) => void;
  onCrossfaderChange: (value: number) => void;
  onTransitionComplete: () => void;
}

let transitionAnimationFrame: number | null = null;
let crossfadeAnimationFrame: number | null = null;
let currentCrossfadeDuration = 8; // seconds

/**
 * Manually trigger a beat-synced transition from one deck to another.
 * The next deck will start playing on the next bar (4 beats) of the current deck.
 */
export function triggerTransition(
  currentDeckId: 'A' | 'B',
  currentDeckState: DeckState,
  nextDeckState: DeckState,
  callbacks: TransitionCallbacks,
  crossfadeDuration: number = 8,
): void {
  currentCrossfadeDuration = crossfadeDuration;
  const currentTrack = currentDeckState.track;
  const nextTrack = nextDeckState.track;
  const nextDeckId = currentDeckId === 'A' ? 'B' : 'A';

  if (!currentTrack?.analysis || !nextTrack?.analysis) {
    console.log('Automix: Both tracks need analysis for transition');
    return;
  }

  // Sync BPM of the next deck to current
  callbacks.onSyncBpm(nextDeckId);

  // Get current BPM and beat timing
  const currentBpm = currentTrack.analysis.manualBpm || currentTrack.analysis.bpm;
  const beatDuration = 60 / currentBpm;

  // Calculate the next bar start (every 4 beats)
  const currentTime = getDeckCurrentTime(currentDeckId);
  const firstBeat = currentTrack.analysis.firstBeatTime || 0;
  const beatsSinceFirst = (currentTime - firstBeat) / beatDuration;
  const currentBar = Math.floor(beatsSinceFirst / 4);
  const nextBarTime = firstBeat + (currentBar + 1) * 4 * beatDuration;

  // Get the first beat time of the next track
  const nextTrackFirstBeat = nextTrack.analysis.firstBeatTime || 0;

  // Seek next track to its first beat
  callbacks.onSeek(nextDeckId, nextTrackFirstBeat);

  // Schedule the start on the next bar
  scheduleNextTrackStart(nextDeckId, currentDeckId, nextBarTime, currentBpm, callbacks);
}

function scheduleNextTrackStart(
  nextDeckId: 'A' | 'B',
  currentDeckId: 'A' | 'B',
  startAtTime: number,
  _targetBpm: number,
  callbacks: TransitionCallbacks,
): void {
  const checkAndStart = () => {
    const currentTime = getDeckCurrentTime(currentDeckId);
    const timeUntilStart = startAtTime - currentTime;

    if (timeUntilStart <= 0.02) {
      // Time to start!
      callbacks.onStartPlay(nextDeckId);

      // Start crossfade animation
      startCrossfade(currentDeckId, nextDeckId, callbacks);

      transitionAnimationFrame = null;
      return;
    }

    // Keep checking at high frequency for precise timing
    transitionAnimationFrame = requestAnimationFrame(checkAndStart);
  };

  transitionAnimationFrame = requestAnimationFrame(checkAndStart);
}

function startCrossfade(
  fromDeckId: 'A' | 'B',
  toDeckId: 'A' | 'B',
  callbacks: TransitionCallbacks,
): void {
  const startTime = performance.now();
  const duration = currentCrossfadeDuration * 1000; // Convert to ms
  const startValue = fromDeckId === 'A' ? -1 : 1;
  const endValue = toDeckId === 'A' ? -1 : 1;

  const animateCrossfade = () => {
    const elapsed = performance.now() - startTime;
    const progress = Math.min(1, elapsed / duration);

    // Use an easing function for smoother transition
    const easedProgress = easeInOutCubic(progress);
    const crossfaderValue = startValue + (endValue - startValue) * easedProgress;

    callbacks.onCrossfaderChange(crossfaderValue);

    if (progress < 1) {
      crossfadeAnimationFrame = requestAnimationFrame(animateCrossfade);
    } else {
      // Transition complete - pause the old deck
      callbacks.onStopDeck(fromDeckId);
      callbacks.onTransitionComplete();
      crossfadeAnimationFrame = null;
    }
  };

  crossfadeAnimationFrame = requestAnimationFrame(animateCrossfade);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Cancel any pending transition
 */
export function cancelTransition(): void {
  if (transitionAnimationFrame !== null) {
    cancelAnimationFrame(transitionAnimationFrame);
    transitionAnimationFrame = null;
  }
  if (crossfadeAnimationFrame !== null) {
    cancelAnimationFrame(crossfadeAnimationFrame);
    crossfadeAnimationFrame = null;
  }
}

/**
 * Get the next beat time for a track at current position
 */
export function getNextBeatTime(deckId: 'A' | 'B', track: Track): number | null {
  if (!track.analysis) return null;

  const currentTime = getDeckCurrentTime(deckId);
  const bpm = track.analysis.manualBpm || track.analysis.bpm;
  const beatDuration = 60 / bpm;
  const firstBeat = track.analysis.firstBeatTime || 0;

  const beatsSinceFirst = Math.floor((currentTime - firstBeat) / beatDuration);
  return firstBeat + (beatsSinceFirst + 1) * beatDuration;
}

/**
 * Get the next bar (4 beats) time for a track
 */
export function getNextBarTime(deckId: 'A' | 'B', track: Track): number | null {
  if (!track.analysis) return null;

  const currentTime = getDeckCurrentTime(deckId);
  const bpm = track.analysis.manualBpm || track.analysis.bpm;
  const beatDuration = 60 / bpm;
  const firstBeat = track.analysis.firstBeatTime || 0;

  const beatsSinceFirst = Math.floor((currentTime - firstBeat) / beatDuration);
  const currentBar = Math.floor(beatsSinceFirst / 4);
  return firstBeat + (currentBar + 1) * 4 * beatDuration;
}

/**
 * Calculate beat grid positions for visualization
 */
export function getBeatGrid(track: Track, startTime: number, endTime: number): number[] {
  if (!track.analysis) return [];

  const bpm = track.analysis.manualBpm || track.analysis.bpm;
  const beatDuration = 60 / bpm;
  const firstBeat = track.analysis.firstBeatTime || 0;

  const beats: number[] = [];

  // Find the first beat in the range
  const beatsBeforeStart = Math.floor((startTime - firstBeat) / beatDuration);
  let currentBeat = firstBeat + beatsBeforeStart * beatDuration;

  while (currentBeat < endTime) {
    if (currentBeat >= startTime) {
      beats.push(currentBeat);
    }
    currentBeat += beatDuration;
  }

  return beats;
}
