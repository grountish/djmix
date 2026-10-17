import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';

export type { StretchNode };

/** Creates the key-lock time-stretcher (Signalsmith Stretch) for one deck. */
export type StretchFactory = (ctx: BaseAudioContext) => Promise<StretchNode>;

/**
 * Input position that only ever reads silence (the stretcher zero-pads before the buffers).
 * A parked stretcher plays from here at rate 0.
 */
export const PARKED_INPUT = -3600;

const PROCESSOR_NAME = 'signalsmith-stretch';
/**
 * Plays from loaded buffers only: no inputs, so the worklet never falls into its live-input
 * mode (some implementations hand an unconnected input a silent channel).
 */
const NODE_OPTIONS: AudioWorkletNodeOptions = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] };

/** Per context: the worklet module registration (done through the library, once). */
const registrations = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * The processor starts in an inactive state that reads the missing input and throws, which
 * kills it for good; it is parked instead and never made inactive. On a running context the
 * library's node can render a few blocks between becoming ready and receiving the parking
 * change, so the node is built by hand and parked before the processor is ready: messages
 * queued until then are replayed the instant it becomes ready, before it renders anything.
 */
export const createStretchNode: StretchFactory = async (ctx) => {
  await registerProcessor(ctx);
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, NODE_OPTIONS);
  node.onprocessorerror = (event) => console.error('[stretch] processor error', event);
  return attach(node);
};

/** Registers the worklet module on the context through the library; its own node is discarded. */
function registerProcessor(ctx: BaseAudioContext): Promise<void> {
  let registration = registrations.get(ctx);
  if (!registration) {
    registration = SignalsmithStretch(ctx, NODE_OPTIONS).then(() => undefined);
    registrations.set(ctx, registration);
  }
  return registration;
}

/**
 * The library's message protocol: `[id, method, ...args]` in, `[id, result]` back, plus
 * `['ready', argCounts]` once and `['time', inputTime]` as playback goes. A method called
 * with one argument more than it declares passes that argument as the transfer list.
 */
function attach(node: AudioWorkletNode): Promise<StretchNode> {
  const stretch = node as StretchNode;
  const replies = new Map<number, (value: unknown) => void>();
  let nextId = 0;
  let onTime: ((inputTime: number) => void) | null = null;
  stretch.inputTime = 0;

  const post = (method: string, args: unknown[], transfer: Transferable[] = []) =>
    new Promise<unknown>((resolve) => {
      const id = nextId++;
      replies.set(id, resolve);
      node.port.postMessage([id, method, ...args], transfer);
    });

  // Queued ahead of the processor's own set-up: applied before its first rendered block.
  void post('schedule', [{ active: true, input: PARKED_INPUT, rate: 0, output: 0 }]);

  return new Promise<StretchNode>((resolve) => {
    node.port.onmessage = (event: MessageEvent<[unknown, unknown]>) => {
      const [id, value] = event.data;
      if (id === 'time') {
        stretch.inputTime = value as number;
        onTime?.(value as number);
        return;
      }
      if (id === 'ready') {
        const methods = stretch as unknown as Record<string, unknown>;
        for (const [method, argCount] of Object.entries(value as Record<string, number>)) {
          methods[method] = (...args: unknown[]) => {
            const transfer = args.length > argCount ? (args.pop() as Transferable[]) : undefined;
            return post(method, args, transfer);
          };
        }
        stretch.setUpdateInterval = (seconds, callback) => {
          onTime = callback;
          return post('setUpdateInterval', [seconds]);
        };
        resolve(stretch);
        return;
      }
      const reply = replies.get(id as number);
      if (reply) {
        replies.delete(id as number);
        reply(value);
      }
    };
  });
}

/**
 * The stretcher compensates its own processing latency, but changes must be scheduled at
 * least this far ahead to land exactly.
 */
export const STRETCH_LEAD = 0.12;

/**
 * Kicks come out this much after the time the stretcher was scheduled for (measured: 1.8 ms at
 * 44.1 kHz, 1.2 ms at 48 kHz). Changes are scheduled this much early to line up with the
 * buffer path.
 */
export const STRETCH_OUTPUT_DELAY = 0.0015;
