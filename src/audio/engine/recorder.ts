import { RECORDER_WORKLET_SOURCE } from './recorderWorklet';

export interface RecorderDump {
  sampleRate: number;
  /** Worklet clock time (seconds on the AudioContext) the dump ends at. */
  endTime: number;
  channels: Float32Array[];
}

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * Keeps the last `seconds` of a node's output in a ring buffer on the audio thread, so that
 * a mix that sounded wrong can be saved after the fact (see BadMixButton). Costs one
 * Float32Array per channel; 90 s stereo at 48 kHz is 35 MB.
 */
export class MasterRecorder {
  private nextId = 1;
  private readonly pending = new Map<number, (dump: RecorderDump) => void>();

  private constructor(
    private readonly node: AudioWorkletNode,
    readonly seconds: number,
  ) {
    node.port.onmessage = (event: MessageEvent<{ type: string; id: number } & RecorderDump>) => {
      if (event.data?.type !== 'dump') return;
      const resolve = this.pending.get(event.data.id);
      if (!resolve) return;
      this.pending.delete(event.data.id);
      resolve({ sampleRate: event.data.sampleRate, endTime: event.data.endTime, channels: event.data.channels });
    };
  }

  /** Records `source` from now on; the node sits on the destination path (outputting silence) so it always renders. */
  static async attach(ctx: BaseAudioContext, source: AudioNode, seconds = 90, channels = 2): Promise<MasterRecorder> {
    let ready = loaded.get(ctx);
    if (!ready) {
      const url = URL.createObjectURL(new Blob([RECORDER_WORKLET_SOURCE], { type: 'text/javascript' }));
      ready = ctx.audioWorklet.addModule(url);
      loaded.set(ctx, ready);
    }
    await ready;
    const node = new AudioWorkletNode(ctx, 'ring-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: 'explicit',
      processorOptions: { frames: Math.ceil(seconds * ctx.sampleRate), channels },
    });
    source.connect(node);
    node.connect(ctx.destination);
    return new MasterRecorder(node, seconds);
  }

  /** The most recent `seconds` (default: everything recorded, up to the buffer length). */
  dump(seconds?: number): Promise<RecorderDump> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.node.port.postMessage({ type: 'dump', id, seconds });
    });
  }

  detach(): void {
    this.node.disconnect();
    this.node.port.onmessage = null;
  }
}
