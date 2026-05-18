import type { PlaybackMode, PlaybackState } from '@/types';
import { getAudioContext, decodeAudioFile } from './decoder';

interface DeckEngine {
  id: 'A' | 'B';
  audioBuffer: AudioBuffer | null;
  sourceNode: AudioBufferSourceNode | null;
  gainNode: GainNode | null;
  stretchNode: AudioWorkletNode | null;
  startTime: number;
  pausedAt: number;
  playbackRate: number;
  playbackMode: PlaybackMode;
  isPlaying: boolean;
  onTimeUpdate?: (time: number) => void;
  onEnded?: () => void;
  animationFrameId?: number;
}

const decks: Record<'A' | 'B', DeckEngine> = {
  A: createDeckEngine('A'),
  B: createDeckEngine('B'),
};

function createDeckEngine(id: 'A' | 'B'): DeckEngine {
  return {
    id,
    audioBuffer: null,
    sourceNode: null,
    gainNode: null,
    stretchNode: null,
    startTime: 0,
    pausedAt: 0,
    playbackRate: 1,
    playbackMode: 'rate',
    isPlaying: false,
  };
}

export async function loadTrackToDeck(deckId: 'A' | 'B', filePath: string): Promise<void> {
  const deck = decks[deckId];

  stopDeck(deckId);

  deck.audioBuffer = await decodeAudioFile(filePath);
  deck.pausedAt = 0;
  deck.startTime = 0;
}

export function loadAudioBufferToDeck(deckId: 'A' | 'B', audioBuffer: AudioBuffer): void {
  const deck = decks[deckId];

  stopDeck(deckId);

  deck.audioBuffer = audioBuffer;
  deck.pausedAt = 0;
  deck.startTime = 0;
}

export function playDeck(deckId: 'A' | 'B'): boolean {
  const deck = decks[deckId];
  if (!deck.audioBuffer || !(deck.audioBuffer instanceof AudioBuffer) || deck.isPlaying)
    return false;

  const ctx = getAudioContext();

  if (ctx.state === 'suspended') {
    ctx.resume();
  }

  const source = ctx.createBufferSource();
  source.buffer = deck.audioBuffer;
  source.playbackRate.value = deck.playbackMode === 'rate' ? deck.playbackRate : 1;

  const gainNode = ctx.createGain();
  gainNode.gain.value = 1;

  source.connect(gainNode);
  gainNode.connect(ctx.destination);

  const offset = deck.pausedAt;
  deck.startTime = ctx.currentTime - offset / deck.playbackRate;

  source.start(0, offset);

  source.onended = () => {
    if (deck.isPlaying) {
      deck.isPlaying = false;
      deck.pausedAt = 0;
      deck.onEnded?.();
    }
  };

  deck.sourceNode = source;
  deck.gainNode = gainNode;
  deck.isPlaying = true;

  startTimeTracking(deckId);
  return true;
}

export function pauseDeck(deckId: 'A' | 'B'): void {
  const deck = decks[deckId];
  if (!deck.isPlaying) return;

  const currentTime = getDeckCurrentTime(deckId);

  if (deck.sourceNode) {
    deck.sourceNode.onended = null;
    deck.sourceNode.stop();
    deck.sourceNode.disconnect();
  }

  if (deck.gainNode) {
    deck.gainNode.disconnect();
  }

  deck.pausedAt = currentTime;
  deck.isPlaying = false;

  stopTimeTracking(deckId);
}

export function stopDeck(deckId: 'A' | 'B'): void {
  pauseDeck(deckId);
  const deck = decks[deckId];
  deck.pausedAt = 0;
  deck.startTime = 0;
}

export function seekDeck(deckId: 'A' | 'B', time: number): void {
  const deck = decks[deckId];
  const wasPlaying = deck.isPlaying;

  if (wasPlaying) {
    pauseDeck(deckId);
  }

  deck.pausedAt = Math.max(0, Math.min(time, deck.audioBuffer?.duration || 0));

  if (wasPlaying) {
    playDeck(deckId);
  }
}

export function setDeckPlaybackRate(deckId: 'A' | 'B', rate: number): void {
  const deck = decks[deckId];
  deck.playbackRate = rate;

  if (deck.isPlaying && deck.sourceNode && deck.playbackMode === 'rate') {
    deck.sourceNode.playbackRate.value = rate;
  }
}

export function setDeckVolume(deckId: 'A' | 'B', volume: number): void {
  const deck = decks[deckId];
  if (deck.gainNode) {
    deck.gainNode.gain.value = Math.max(0, Math.min(1, volume));
  }
}

export function setDeckPlaybackMode(deckId: 'A' | 'B', mode: PlaybackMode): void {
  const deck = decks[deckId];
  const wasPlaying = deck.isPlaying;
  const currentTime = deck.isPlaying ? getDeckCurrentTime(deckId) : deck.pausedAt;

  if (wasPlaying) {
    pauseDeck(deckId);
  }

  deck.playbackMode = mode;
  deck.pausedAt = currentTime;

  if (wasPlaying) {
    playDeck(deckId);
  }
}

export function getDeckCurrentTime(deckId: 'A' | 'B'): number {
  const deck = decks[deckId];
  if (!deck.isPlaying) return deck.pausedAt;

  const ctx = getAudioContext();
  const elapsed = (ctx.currentTime - deck.startTime) * deck.playbackRate;
  return Math.min(elapsed, deck.audioBuffer?.duration || 0);
}

export function getDeckDuration(deckId: 'A' | 'B'): number {
  return decks[deckId].audioBuffer?.duration || 0;
}

export function getDeckState(deckId: 'A' | 'B'): PlaybackState {
  const deck = decks[deckId];
  return {
    isPlaying: deck.isPlaying,
    currentTime: getDeckCurrentTime(deckId),
    duration: deck.audioBuffer?.duration || 0,
    playbackRate: deck.playbackRate,
    volume: deck.gainNode?.gain.value || 1,
  };
}

export function setDeckTimeUpdateCallback(
  deckId: 'A' | 'B',
  callback: (time: number) => void,
): void {
  decks[deckId].onTimeUpdate = callback;
}

export function setDeckEndedCallback(deckId: 'A' | 'B', callback: () => void): void {
  decks[deckId].onEnded = callback;
}

function startTimeTracking(deckId: 'A' | 'B'): void {
  const deck = decks[deckId];

  const tick = () => {
    if (deck.isPlaying) {
      deck.onTimeUpdate?.(getDeckCurrentTime(deckId));
      deck.animationFrameId = requestAnimationFrame(tick);
    }
  };

  deck.animationFrameId = requestAnimationFrame(tick);
}

function stopTimeTracking(deckId: 'A' | 'B'): void {
  const deck = decks[deckId];
  if (deck.animationFrameId) {
    cancelAnimationFrame(deck.animationFrameId);
    deck.animationFrameId = undefined;
  }
}

export function calculateTempoRatio(sourceBpm: number, targetBpm: number): number {
  return targetBpm / sourceBpm;
}

export function syncDeckToTargetBpm(deckId: 'A' | 'B', sourceBpm: number, targetBpm: number): void {
  const ratio = calculateTempoRatio(sourceBpm, targetBpm);
  setDeckPlaybackRate(deckId, ratio);
}

export function getDeckAudioBuffer(deckId: 'A' | 'B'): AudioBuffer | null {
  const buffer = decks[deckId].audioBuffer;
  return buffer instanceof AudioBuffer ? buffer : null;
}

// Check if the deck engine is actually playing (ignoring React state)
export function isDeckEnginePlaying(deckId: 'A' | 'B'): boolean {
  return decks[deckId].isPlaying;
}

// Force stop the deck, ensuring audio is stopped regardless of state
export function forceStopDeck(deckId: 'A' | 'B'): void {
  const deck = decks[deckId];

  // Save current position before stopping
  if (deck.isPlaying) {
    deck.pausedAt = getDeckCurrentTime(deckId);
  }

  // Stop any existing source
  if (deck.sourceNode) {
    try {
      deck.sourceNode.onended = null;
      deck.sourceNode.stop();
      deck.sourceNode.disconnect();
    } catch (e) {
      // Ignore errors if already stopped
    }
    deck.sourceNode = null;
  }

  if (deck.gainNode) {
    try {
      deck.gainNode.disconnect();
    } catch (e) {
      // Ignore errors
    }
    deck.gainNode = null;
  }

  deck.isPlaying = false;
  stopTimeTracking(deckId);
}
