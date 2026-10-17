import type { CrossfaderSettings } from './engine/crossfaderCurve';
import { type FxSettings, setFx, setFxTempo } from './engine/fx';
import { getMixGraph } from './engine/liveGraph';
import { type DeckId, getChannelFx, setCrossfaderCurve as setGraphCrossfaderCurve } from './engine/mixGraph';

export type { CrossfaderCurve, CrossfaderSettings } from './engine/crossfaderCurve';
export { CROSSFADER_CURVES, DEFAULT_CROSSFADER } from './engine/crossfaderCurve';
export type { FxSettings, FxType } from './engine/fx';
export { DEFAULT_FX, FX_BEATS, FX_TYPES } from './engine/fx';

/** Selects a channel's effect and its beats and amount (the effect nodes are built on first use). */
export function setDeckFx(deckId: DeckId, settings: FxSettings): void {
  setFx(getChannelFx(getMixGraph(), deckId), settings);
}

/** The deck's playing tempo (track BPM × rate), for beat-synced effects. */
export function setDeckFxTempo(deckId: DeckId, bpm: number): void {
  const fx = getMixGraph().decks[deckId].fx;
  if (fx) setFxTempo(fx, bpm);
}

/** The crossfader law (smooth / sharp / linear, reversed or not); automix sweeps follow it too. */
export function setCrossfaderCurve(settings: CrossfaderSettings): void {
  setGraphCrossfaderCurve(getMixGraph(), settings);
}
