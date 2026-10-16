import { clamp } from './engine/curves';
import { getMixGraph } from './engine/liveGraph';
import {
  type DeckId,
  scheduleCrossfade as scheduleGraphCrossfade,
  setCrossfaderPosition,
  setParamSmooth,
} from './engine/mixGraph';

/** -1 = full A, 0 = centre, 1 = full B (equal-power law). */
export function setCrossfader(value: number): void {
  setCrossfaderPosition(getMixGraph(), clamp(value, -1, 1));
}

export function setMasterVolume(volume: number): void {
  const graph = getMixGraph();
  setParamSmooth(graph.master.gain, clamp(volume, 0, 1), graph.ctx);
}

export function setChannelFader(deckId: DeckId, volume: number): void {
  const graph = getMixGraph();
  setParamSmooth(graph.decks[deckId].fader.gain, clamp(volume, 0, 1), graph.ctx);
}

/** Automates the crossfader from `from` to `to` on the audio clock, starting at `startTime`. */
export function scheduleCrossfade(
  from: number,
  to: number,
  startTime: number,
  duration: number,
): void {
  scheduleGraphCrossfade(getMixGraph(), from, to, startTime, duration);
}
