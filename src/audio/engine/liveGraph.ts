import { getAudioContext } from '../decoder';
import { attachLimiter } from './limiter';
import { createMixGraph, type DeckId, type MixGraph } from './mixGraph';
import { MasterRecorder } from './recorder';

export type MeterTarget = DeckId | 'master';

let graph: MixGraph | null = null;
let meters: Partial<Record<MeterTarget, AnalyserNode>> = {};
let recorder: Promise<MasterRecorder> | null = null;
/** Resolves once the limiter sits behind the master fader (it rewires the master's outputs). */
let limiterAttached: Promise<void> = Promise.resolve();

/** The app's single mix graph, bound to the shared AudioContext. */
export function getMixGraph(): MixGraph {
  const ctx = getAudioContext();
  if (!graph || graph.ctx !== ctx) {
    graph = createMixGraph(ctx);
    meters = {};
    recorder = null;
    limiterAttached = attachLimiter(graph).catch((error) => console.error('Master limiter unavailable:', error));
  }
  return graph;
}

/** Seconds of master output the "bad mix" recorder keeps. */
export const RECORDER_SECONDS = 90;

/** The master recorder (before the limiter), attached on first use and kept from then on. */
export function getMasterRecorder(): Promise<MasterRecorder> {
  const mix = getMixGraph();
  if (!recorder) {
    recorder = limiterAttached.then(() => MasterRecorder.attach(mix.ctx, mix.master, RECORDER_SECONDS));
    recorder.catch(() => {
      recorder = null;
    });
  }
  return recorder;
}

/** Level tap for the UI meters: after a channel fader, or on the master sum (before the limiter). */
export function getMeter(target: MeterTarget): AnalyserNode {
  const mix = getMixGraph();
  let meter = meters[target];
  if (!meter) {
    const analyser = mix.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    if (target === 'master') {
      // Attaching the limiter disconnects everything from the master, so tap it afterwards.
      limiterAttached.then(() => mix.master.connect(analyser));
    } else {
      mix.decks[target].fader.connect(analyser);
    }
    meter = meters[target] = analyser;
  }
  return meter;
}
