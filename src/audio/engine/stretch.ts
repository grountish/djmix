import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';

export type { StretchNode };

/** Creates the key-lock time-stretcher (Signalsmith Stretch) for one deck. */
export type StretchFactory = (ctx: BaseAudioContext) => Promise<StretchNode>;

/**
 * Input position that only ever reads silence (the stretcher zero-pads before the buffers).
 * A parked stretcher plays from here at rate 0.
 */
export const PARKED_INPUT = -3600;

/**
 * Plays from loaded buffers only: no inputs, so the worklet never falls into its live-input
 * mode (some implementations hand an unconnected input a silent channel). Its inactive state
 * reads the missing input and throws, so the node is parked instead and never made inactive.
 */
export const createStretchNode: StretchFactory = async (ctx) => {
  const node = await SignalsmithStretch(ctx, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  await node.schedule({ active: true, input: PARKED_INPUT, rate: 0, output: ctx.currentTime });
  return node;
};

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
