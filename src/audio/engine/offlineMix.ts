import { DeckPlayer } from './deckPlayer';
import { createMixGraph, type DeckId, type MixGraph } from './mixGraph';

export interface OfflineMix {
  ctx: OfflineAudioContext;
  graph: MixGraph;
  decks: Record<DeckId, DeckPlayer>;
}

/**
 * Builds the same mix graph and deck players the app uses on an OfflineAudioContext, so a mix
 * can be rendered faster than real time and measured.
 */
export function createOfflineMix(ctx: OfflineAudioContext, destination?: AudioNode): OfflineMix {
  const graph = createMixGraph(ctx, destination);
  return {
    ctx,
    graph,
    decks: {
      A: new DeckPlayer(ctx, graph.decks.A.input),
      B: new DeckPlayer(ctx, graph.decks.B.input),
    },
  };
}
