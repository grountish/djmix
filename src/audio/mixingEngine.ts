import { clamp } from './engine/curves';
import { getMixGraph } from './engine/liveGraph';
import {
  type DeckId,
  type EqBand,
  scheduleCrossfade as scheduleGraphCrossfade,
  setCrossfaderPosition,
  setEqBand,
  setFilter,
  setParamSmooth,
  setTrim,
} from './engine/mixGraph';

/** Loudness every track is trimmed towards; the master limiter catches what's left. */
const TARGET_LUFS = -11;
const MAX_TRIM_CUT_DB = -12;
const MAX_TRIM_BOOST_DB = 6;

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

export function setDeckEq(deckId: DeckId, band: EqBand, position: number): void {
  setEqBand(getMixGraph(), deckId, band, position);
}

export function setDeckFilter(deckId: DeckId, position: number): void {
  setFilter(getMixGraph(), deckId, position);
}

/** Trims the deck so the track plays near the target loudness; unknown loudness means 0 dB. */
export function setDeckAutoGain(deckId: DeckId, integratedLufs: number | undefined): void {
  const trimDb =
    integratedLufs === undefined || !Number.isFinite(integratedLufs)
      ? 0
      : clamp(TARGET_LUFS - integratedLufs, MAX_TRIM_CUT_DB, MAX_TRIM_BOOST_DB);
  setTrim(getMixGraph(), deckId, trimDb);
}
