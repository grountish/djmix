import { setDeckVolume, getDeckState, playDeck, pauseDeck } from './playbackEngine';

let crossfaderValue = 0;
let masterVolume = 1;

export function setCrossfader(value: number): void {
  crossfaderValue = Math.max(-1, Math.min(1, value));
  applyCrossfaderVolumes();
}

export function getCrossfader(): number {
  return crossfaderValue;
}

export function setMasterVolume(volume: number): void {
  masterVolume = Math.max(0, Math.min(1, volume));
  applyCrossfaderVolumes();
}

export function getMasterVolume(): number {
  return masterVolume;
}

function applyCrossfaderVolumes(): void {
  const volumeA = calculateDeckVolume('A', crossfaderValue) * masterVolume;
  const volumeB = calculateDeckVolume('B', crossfaderValue) * masterVolume;

  setDeckVolume('A', volumeA);
  setDeckVolume('B', volumeB);
}

function calculateDeckVolume(deck: 'A' | 'B', crossfader: number): number {
  if (deck === 'A') {
    if (crossfader <= 0) return 1;
    return 1 - crossfader;
  } else {
    if (crossfader >= 0) return 1;
    return 1 + crossfader;
  }
}

export function playBothDecks(): void {
  playDeck('A');
  playDeck('B');
}

export function pauseBothDecks(): void {
  pauseDeck('A');
  pauseDeck('B');
}

export function getMixState() {
  return {
    deckA: getDeckState('A'),
    deckB: getDeckState('B'),
    crossfader: crossfaderValue,
    masterVolume,
  };
}
