import { crossfaderGainsFor, type CrossfaderSettings, DEFAULT_CROSSFADER } from './crossfaderCurve';
import { eqKnobToGain, filterKnobToCutoffs, settleHighpass } from './curves';
import { type ChannelFx, createChannelFx } from './fx';

export type DeckId = 'A' | 'B';

/**
 * Persistent per-deck signal chain. Sources connect to `input`; the nodes live as long as the
 * graph, so levels survive play, pause and seek.
 */
export interface DeckChannel {
  /** Entry point for deck sources; also carries the loudness trim. */
  input: GainNode;
  /** 3-band isolator: each band can be cut to silence. */
  eq: Record<EqBand, GainNode>;
  filter: { lowpass: BiquadFilterNode; highpass: BiquadFilterNode };
  /** Channel (line) fader. */
  fader: GainNode;
  /** This deck's share of the crossfader. */
  crossfade: GainNode;
  /** Post-fader effects, built on first use (see `getChannelFx`). */
  fx: ChannelFx | null;
}

export interface MixGraph {
  ctx: BaseAudioContext;
  decks: Record<DeckId, DeckChannel>;
  master: GainNode;
  crossfader: { settings: CrossfaderSettings; position: number };
}

export type EqBand = 'low' | 'mid' | 'high';

/** Isolator crossovers, shared with the analysis band energies. */
export const LOW_MID_CROSSOVER_HZ = 200;
export const MID_HIGH_CROSSOVER_HZ = 2500;

/** Butterworth Q (1/√2). Web Audio reads low/high-pass Q in dB, all-pass Q as a plain ratio. */
const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);
/** A gentle resonance on the DJ filter sweep. */
const FILTER_Q_DB = 1;

/** Time constant for UI-driven moves: removes zipper noise, still feels instant. */
const PARAM_SMOOTHING = 0.01;

/** Points per scheduled crossfade curve; plenty for a smooth sweep. */
const CROSSFADE_CURVE_POINTS = 256;

/**
 * Builds the mixer on any context: the live AudioContext in the app, an OfflineAudioContext
 * in tests and offline renders.
 */
export function createMixGraph(
  ctx: BaseAudioContext,
  destination: AudioNode = ctx.destination,
): MixGraph {
  const master = ctx.createGain();
  master.connect(destination);

  const createChannel = (): DeckChannel => {
    const input = ctx.createGain();
    const eqSum = ctx.createGain();
    const eq = createIsolator(ctx, input, eqSum);
    const lowpass = biquad(ctx, 'lowpass', ctx.sampleRate / 2, FILTER_Q_DB);
    const highpass = biquad(ctx, 'highpass', 0, FILTER_Q_DB);
    const fader = ctx.createGain();
    const crossfade = ctx.createGain();
    connectChain(eqSum, lowpass, highpass, fader, crossfade, master);
    return { input, eq, filter: { lowpass, highpass }, fader, crossfade, fx: null };
  };

  const decks = { A: createChannel(), B: createChannel() };
  const crossfader = { settings: { ...DEFAULT_CROSSFADER }, position: 0 };
  const centre = crossfaderGainsFor(crossfader.settings, 0);
  decks.A.crossfade.gain.value = centre.a;
  decks.B.crossfade.gain.value = centre.b;

  return { ctx, decks, master, crossfader };
}

/** The channel's effects, inserted between its fader and the crossfader on first use. */
export function getChannelFx(graph: MixGraph, deck: DeckId): ChannelFx {
  const channel = graph.decks[deck];
  if (!channel.fx) channel.fx = createChannelFx(graph.ctx, channel.fader, channel.crossfade);
  return channel.fx;
}

function biquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  frequency: number,
  q: number,
): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

function connectChain(...nodes: AudioNode[]): void {
  for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]);
}

/**
 * Linkwitz-Riley 4th-order 3-band split. The low band also passes the high crossover's
 * all-pass, so the three bands sum back to a flat response.
 */
function createIsolator(
  ctx: BaseAudioContext,
  input: AudioNode,
  output: AudioNode,
): Record<EqBand, GainNode> {
  const lr4 = (type: 'lowpass' | 'highpass', frequency: number) => [
    biquad(ctx, type, frequency, BUTTERWORTH_Q_DB),
    biquad(ctx, type, frequency, BUTTERWORTH_Q_DB),
  ];
  const bands = { low: ctx.createGain(), mid: ctx.createGain(), high: ctx.createGain() };

  connectChain(
    input,
    ...lr4('lowpass', LOW_MID_CROSSOVER_HZ),
    biquad(ctx, 'allpass', MID_HIGH_CROSSOVER_HZ, Math.SQRT1_2),
    bands.low,
    output,
  );
  const upper = lr4('highpass', LOW_MID_CROSSOVER_HZ);
  connectChain(input, ...upper);
  const upperOut = upper[upper.length - 1];
  connectChain(upperOut, ...lr4('lowpass', MID_HIGH_CROSSOVER_HZ), bands.mid, output);
  connectChain(upperOut, ...lr4('highpass', MID_HIGH_CROSSOVER_HZ), bands.high, output);
  return bands;
}

/** Glides a parameter to `value` from wherever it is now, dropping any scheduled automation. */
export function setParamSmooth(param: AudioParam, value: number, ctx: BaseAudioContext): void {
  const now = ctx.currentTime;
  param.cancelAndHoldAtTime(now);
  param.setTargetAtTime(value, now, PARAM_SMOOTHING);
}

export function setCrossfaderPosition(graph: MixGraph, position: number): void {
  graph.crossfader.position = position;
  const { a, b } = crossfaderGainsFor(graph.crossfader.settings, position);
  setParamSmooth(graph.decks.A.crossfade.gain, a, graph.ctx);
  setParamSmooth(graph.decks.B.crossfade.gain, b, graph.ctx);
}

/** Changes the crossfader law and re-applies the current position on it. */
export function setCrossfaderCurve(graph: MixGraph, settings: CrossfaderSettings): void {
  graph.crossfader.settings = { ...settings };
  setCrossfaderPosition(graph, graph.crossfader.position);
}

/**
 * Schedules a crossfader sweep on the audio clock. The crossfader holds its
 * current level until `startTime`, then follows the curve sample-accurately.
 */
export function scheduleCrossfade(
  graph: MixGraph,
  from: number,
  to: number,
  startTime: number,
  duration: number,
): void {
  const curveA = new Float32Array(CROSSFADE_CURVE_POINTS);
  const curveB = new Float32Array(CROSSFADE_CURVE_POINTS);
  for (let i = 0; i < CROSSFADE_CURVE_POINTS; i++) {
    const position = from + ((to - from) * i) / (CROSSFADE_CURVE_POINTS - 1);
    const { a, b } = crossfaderGainsFor(graph.crossfader.settings, position);
    curveA[i] = a;
    curveB[i] = b;
  }
  graph.crossfader.position = to;

  const now = graph.ctx.currentTime;
  const start = Math.max(startTime, now);
  for (const [param, curve] of [
    [graph.decks.A.crossfade.gain, curveA],
    [graph.decks.B.crossfade.gain, curveB],
  ] as const) {
    param.cancelAndHoldAtTime(now);
    param.setValueCurveAtTime(curve, start, duration);
  }
}

/** EQ knob position (-1 kill … 0 unity … +1 = +6 dB) for one band. */
export function setEqBand(graph: MixGraph, deck: DeckId, band: EqBand, position: number): void {
  setParamSmooth(graph.decks[deck].eq[band].gain, eqKnobToGain(position), graph.ctx);
}

/** Filter knob position (-1 low-pass … 0 off … +1 high-pass). */
export function setFilter(graph: MixGraph, deck: DeckId, position: number): void {
  const { lowpassHz, highpassHz } = filterKnobToCutoffs(position, graph.ctx.sampleRate / 2);
  const { lowpass, highpass } = graph.decks[deck].filter;
  setParamSmooth(lowpass.frequency, lowpassHz, graph.ctx);
  // Never glides through the sub-hertz region (see settleHighpass).
  settleHighpass(highpass.frequency, highpassHz, graph.ctx, PARAM_SMOOTHING);
}

/** Loudness trim in dB, applied before the EQ. */
export function setTrim(graph: MixGraph, deck: DeckId, gainDb: number): void {
  setParamSmooth(graph.decks[deck].input.gain, Math.pow(10, gainDb / 20), graph.ctx);
}
