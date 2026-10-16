import { getAudioContext } from '../decoder';
import { attachLimiter } from './limiter';
import { createMixGraph, type MixGraph } from './mixGraph';

let graph: MixGraph | null = null;

/** The app's single mix graph, bound to the shared AudioContext. */
export function getMixGraph(): MixGraph {
  const ctx = getAudioContext();
  if (!graph || graph.ctx !== ctx) {
    graph = createMixGraph(ctx);
    attachLimiter(graph).catch((error) => console.error('Master limiter unavailable:', error));
  }
  return graph;
}
