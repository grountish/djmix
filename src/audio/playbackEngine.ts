import type { PlaybackMode } from '@/types';
import { getAudioContext, decodeAudioFile } from './decoder';
import { DeckPlayer } from './engine/deckPlayer';
import { getMixGraph } from './engine/liveGraph';
import type { DeckId, MixGraph } from './engine/mixGraph';
import type { PlayheadAnchor } from './engine/transport';

interface DeckEngine {
  player: DeckPlayer;
  /** Tempo ratio requested by the UI; applied to the source only in rate mode. */
  playbackRate: number;
  playbackMode: PlaybackMode;
  onTimeUpdate?: (time: number) => void;
  onEnded?: () => void;
  animationFrameId?: number;
}

let decks: Record<DeckId, DeckEngine> | null = null;
let decksGraph: MixGraph | null = null;

function getDeck(deckId: DeckId): DeckEngine {
  const graph = getMixGraph();
  if (!decks || decksGraph !== graph) {
    decks = { A: createDeckEngine(graph, 'A'), B: createDeckEngine(graph, 'B') };
    decksGraph = graph;
  }
  return decks[deckId];
}

function createDeckEngine(graph: MixGraph, id: DeckId): DeckEngine {
  const deck: DeckEngine = {
    player: new DeckPlayer(graph.ctx, graph.decks[id].input),
    playbackRate: 1,
    playbackMode: 'rate',
  };
  deck.player.onEnded = () => {
    stopTimeTracking(deck);
    deck.onEnded?.();
  };
  return deck;
}

function appliedRate(deck: DeckEngine): number {
  return deck.playbackMode === 'rate' ? deck.playbackRate : 1;
}

export async function loadTrackToDeck(deckId: DeckId, filePath: string): Promise<void> {
  stopDeck(deckId);
  getDeck(deckId).player.load(await decodeAudioFile(filePath));
}

export function loadAudioBufferToDeck(deckId: DeckId, audioBuffer: AudioBuffer): void {
  stopDeck(deckId);
  getDeck(deckId).player.load(audioBuffer);
}

/** Starts the deck at audio-clock time `when` (default: now). */
export function playDeck(deckId: DeckId, when?: number): boolean {
  const deck = getDeck(deckId);
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    ctx.resume();
  }

  const started = deck.player.play(when);
  if (started) {
    startTimeTracking(deck);
  }
  return started;
}

export function pauseDeck(deckId: DeckId): void {
  const deck = getDeck(deckId);
  deck.player.pause();
  stopTimeTracking(deck);
}

export function stopDeck(deckId: DeckId): void {
  const deck = getDeck(deckId);
  deck.player.stop();
  stopTimeTracking(deck);
}

export function seekDeck(deckId: DeckId, time: number): void {
  getDeck(deckId).player.seek(time);
}

export function setDeckPlaybackRate(deckId: DeckId, rate: number): void {
  const deck = getDeck(deckId);
  deck.playbackRate = rate;
  deck.player.setRate(appliedRate(deck));
}

export function setDeckPlaybackMode(deckId: DeckId, mode: PlaybackMode): void {
  const deck = getDeck(deckId);
  deck.playbackMode = mode;
  deck.player.setRate(appliedRate(deck));
}

export function getDeckCurrentTime(deckId: DeckId): number {
  return getDeck(deckId).player.currentTime();
}

export function getDeckDuration(deckId: DeckId): number {
  return getDeck(deckId).player.duration;
}

/** Where the deck's playhead sits on the audio clock; null when stopped. */
export function getDeckAnchor(deckId: DeckId): PlayheadAnchor | null {
  return getDeck(deckId).player.getAnchor();
}

export function setDeckTimeUpdateCallback(deckId: DeckId, callback: (time: number) => void): void {
  getDeck(deckId).onTimeUpdate = callback;
}

export function setDeckEndedCallback(deckId: DeckId, callback: () => void): void {
  getDeck(deckId).onEnded = callback;
}

// UI refresh only; audio timing never depends on animation frames.
function startTimeTracking(deck: DeckEngine): void {
  stopTimeTracking(deck);

  const tick = () => {
    if (deck.player.isPlaying) {
      deck.onTimeUpdate?.(deck.player.currentTime());
      deck.animationFrameId = requestAnimationFrame(tick);
    }
  };

  deck.animationFrameId = requestAnimationFrame(tick);
}

function stopTimeTracking(deck: DeckEngine): void {
  if (deck.animationFrameId) {
    cancelAnimationFrame(deck.animationFrameId);
    deck.animationFrameId = undefined;
  }
}

export function calculateTempoRatio(sourceBpm: number, targetBpm: number): number {
  return targetBpm / sourceBpm;
}

export function syncDeckToTargetBpm(deckId: DeckId, sourceBpm: number, targetBpm: number): void {
  setDeckPlaybackRate(deckId, calculateTempoRatio(sourceBpm, targetBpm));
}

export function getDeckAudioBuffer(deckId: DeckId): AudioBuffer | null {
  return getDeck(deckId).player.audioBuffer;
}

// Check if the deck engine is actually playing (ignoring React state)
export function isDeckEnginePlaying(deckId: DeckId): boolean {
  return getDeck(deckId).player.isPlaying;
}

// Stop output, keeping the playhead position
export function forceStopDeck(deckId: DeckId): void {
  pauseDeck(deckId);
}
