import limiterSource from './limiter.worklet.js?raw';
import type { MixGraph } from './mixGraph';

/** Sample-peak ceiling; the margin below 0 dBFS absorbs inter-sample peaks (≈ -1 dBTP). */
export const LIMITER_CEILING_DB = -1.5;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Lookahead brickwall limiter (5 ms latency). Loaded from a Blob URL, which works under file://. */
export async function createLimiter(ctx: BaseAudioContext): Promise<AudioWorkletNode> {
  let ready = loaded.get(ctx);
  if (!ready) {
    const url = URL.createObjectURL(new Blob([limiterSource], { type: 'text/javascript' }));
    ready = ctx.audioWorklet.addModule(url);
    loaded.set(ctx, ready);
  }
  await ready;
  return new AudioWorkletNode(ctx, 'lookahead-limiter', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { ceilingDb: LIMITER_CEILING_DB },
  });
}

/** Puts the limiter between the master fader and `destination`. */
export async function attachLimiter(
  graph: MixGraph,
  destination: AudioNode = graph.ctx.destination,
): Promise<void> {
  const limiter = await createLimiter(graph.ctx);
  graph.master.disconnect();
  graph.master.connect(limiter);
  limiter.connect(destination);
}
