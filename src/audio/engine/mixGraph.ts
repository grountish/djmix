import { equalPowerGains } from './curves';

export type DeckId = 'A' | 'B';

/**
 * Persistent per-deck signal chain. Sources connect to `input`; the nodes live as long as the
 * graph, so levels survive play, pause and seek.
 */
export interface DeckChannel {
  /** Entry point for deck sources; also carries the loudness trim. */
  input: GainNode;
  /** Channel (line) fader. */
  fader: GainNode;
  /** This deck's share of the crossfader. */
  crossfade: GainNode;
}

export interface MixGraph {
  ctx: BaseAudioContext;
  decks: Record<DeckId, DeckChannel>;
  master: GainNode;
}

/** Time constant for UI-driven moves: removes zipper noise, still feels instant. */
const PARAM_SMOOTHING = 0.01;

/** Points per scheduled crossfade curve; plenty for a smooth equal-power sweep. */
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
    const fader = ctx.createGain();
    const crossfade = ctx.createGain();
    input.connect(fader);
    fader.connect(crossfade);
    crossfade.connect(master);
    return { input, fader, crossfade };
  };

  const decks = { A: createChannel(), B: createChannel() };
  const centre = equalPowerGains(0);
  decks.A.crossfade.gain.value = centre.a;
  decks.B.crossfade.gain.value = centre.b;

  return { ctx, decks, master };
}

/** Glides a parameter to `value` from wherever it is now, dropping any scheduled automation. */
export function setParamSmooth(param: AudioParam, value: number, ctx: BaseAudioContext): void {
  const now = ctx.currentTime;
  param.cancelAndHoldAtTime(now);
  param.setTargetAtTime(value, now, PARAM_SMOOTHING);
}

export function setCrossfaderPosition(graph: MixGraph, position: number): void {
  const { a, b } = equalPowerGains(position);
  setParamSmooth(graph.decks.A.crossfade.gain, a, graph.ctx);
  setParamSmooth(graph.decks.B.crossfade.gain, b, graph.ctx);
}

/**
 * Schedules an equal-power crossfader sweep on the audio clock. The crossfader holds its
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
    const { a, b } = equalPowerGains(position);
    curveA[i] = a;
    curveB[i] = b;
  }

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
