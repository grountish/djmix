import { getAudioContext } from '../decoder';
import { attachLimiter } from './limiter';
import { createMixGraph, type DeckId, type MixGraph } from './mixGraph';

export type MeterTarget = DeckId | 'master';

let graph: MixGraph | null = null;
let meters: Partial<Record<MeterTarget, AnalyserNode>> = {};

/** The app's single mix graph, bound to the shared AudioContext. */
export function getMixGraph(): MixGraph {
  const ctx = getAudioContext();
  if (!graph || graph.ctx !== ctx) {
    graph = createMixGraph(ctx);
    meters = {};
    attachLimiter(graph).catch((error) => console.error('Master limiter unavailable:', error));
  }
  return graph;
}

/** Level tap for the UI meters: after a channel fader, or on the master sum (before the limiter). */
export function getMeter(target: MeterTarget): AnalyserNode {
  const mix = getMixGraph();
  let meter = meters[target];
  if (!meter) {
    meter = mix.ctx.createAnalyser();
    meter.fftSize = 1024;
    meter.smoothingTimeConstant = 0;
    (target === 'master' ? mix.master : mix.decks[target].fader).connect(meter);
    meters[target] = meter;
  }
  return meter;
}
