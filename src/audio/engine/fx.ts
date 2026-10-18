import { clamp } from './curves';

/**
 * Channel effects, inserted after the channel fader (a tail rings on after the fader is
 * pulled down, the echo-out move). Echo, flanger and phaser follow the deck's tempo.
 */
export type FxType = 'echo' | 'flanger' | 'phaser' | 'reverb';

export interface FxSettings {
  /** Null: off (a running tail still decays). */
  type: FxType | null;
  /** Echo: the delay in beats. Flanger / phaser: beats per sweep. Reverb: ignored. */
  beats: number;
  /**
   * Dry/wet 0–1, equal power: 0 is the dry signal alone, 1 the effect alone (an echo-out
   * leaves only the repeats), ½ both at −3 dB. The echo's feedback grows with it. With no
   * effect selected the dry signal passes at unity whatever the value.
   */
  amount: number;
}

export const DEFAULT_FX: FxSettings = { type: null, beats: 0.5, amount: 0.5 };

export const FX_TYPES: { type: FxType; label: string; beatSynced: boolean }[] = [
  { type: 'echo', label: 'Echo', beatSynced: true },
  { type: 'flanger', label: 'Flanger', beatSynced: true },
  { type: 'phaser', label: 'Phaser', beatSynced: true },
  { type: 'reverb', label: 'Reverb', beatSynced: false },
];

/** Beat divisions offered for the echo delay and the flanger / phaser sweep. */
export const FX_BEATS = [0.25, 0.5, 0.75, 1, 2, 4, 8, 16];

const MAX_ECHO_SECONDS = 4;
const MIN_ECHO_SECONDS = 0.02;
/** Each echo repeat loses its top end, like tape. */
const ECHO_DAMP_HZ = 4000;
/** Feedback at amount 0 and the extra feedback at amount 1. */
const ECHO_FEEDBACK_BASE = 0.3;
const ECHO_FEEDBACK_RANGE = 0.45;

const FLANGER_BASE_SECONDS = 0.003;
const FLANGER_DEPTH_SECONDS = 0.0022;
const FLANGER_FEEDBACK = 0.5;

const PHASER_STAGES = 4;
const PHASER_BASE_HZ = 1000;
const PHASER_DEPTH_HZ = 700;

const REVERB_SECONDS = 2;
/** Decay to -60 dB over the reverb length. */
const REVERB_DECAY_DB = 60;

/** Time constant for parameter moves: no zipper noise, still immediate. */
const SMOOTHING = 0.01;
/** Echo delay moves slower: a quick move pitch-bends the tail, a slow one glides. */
const DELAY_SMOOTHING = 0.03;

export interface ChannelFx {
  ctx: BaseAudioContext;
  /** The dry path, `source` → `output`, so the mix can take it away. */
  dry: GainNode;
  /** Wet sum into the channel's output. */
  wet: GainNode;
  echo: { input: GainNode; delay: DelayNode; feedback: GainNode; damp: BiquadFilterNode };
  flanger: { input: GainNode; delay: DelayNode; lfo: OscillatorNode; depth: GainNode; feedback: GainNode };
  phaser: { input: GainNode; stages: BiquadFilterNode[]; lfo: OscillatorNode; depth: GainNode };
  reverb: { input: GainNode; convolver: ConvolverNode };
  settings: FxSettings;
  bpm: number;
}

/** Echo delay for `beats` at `bpm`, within the delay line. */
export function echoDelaySeconds(beats: number, bpm: number): number {
  return clamp((beats * 60) / bpm, MIN_ECHO_SECONDS, MAX_ECHO_SECONDS);
}

/** Sweep rate for one cycle every `beats` beats at `bpm`. */
export function lfoHz(beats: number, bpm: number): number {
  return bpm / 60 / Math.max(beats, 0.25);
}

/**
 * Builds the effects for one channel: `source` (post-fader) in, `output` out. Nothing is
 * selected. The direct `source` → `output` connection is replaced by the dry gain, so the
 * dry/wet mix can take the dry signal away.
 */
export function createChannelFx(ctx: BaseAudioContext, source: AudioNode, output: AudioNode, bpm = 120): ChannelFx {
  const dry = ctx.createGain();
  dry.gain.value = 1;
  try {
    source.disconnect(output);
  } catch {
    // Not connected directly: nothing to replace.
  }
  source.connect(dry);
  dry.connect(output);

  const wet = ctx.createGain();
  wet.gain.value = 0;
  wet.connect(output);

  const input = () => {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    return gain;
  };

  // Echo: input → delay → wet, delay → damp → feedback → delay.
  const echoInput = input();
  const echoDelay = ctx.createDelay(MAX_ECHO_SECONDS);
  const echoDamp = ctx.createBiquadFilter();
  echoDamp.type = 'lowpass';
  echoDamp.frequency.value = ECHO_DAMP_HZ;
  const echoFeedback = ctx.createGain();
  echoFeedback.gain.value = ECHO_FEEDBACK_BASE;
  echoInput.connect(echoDelay);
  echoDelay.connect(echoDamp);
  echoDamp.connect(echoFeedback);
  echoFeedback.connect(echoDelay);
  echoDelay.connect(wet);

  // Flanger: a short delay swept by an LFO, with feedback.
  const flangerInput = input();
  const flangerDelay = ctx.createDelay(0.05);
  flangerDelay.delayTime.value = FLANGER_BASE_SECONDS;
  const flangerLfo = ctx.createOscillator();
  flangerLfo.type = 'sine';
  const flangerDepth = ctx.createGain();
  flangerDepth.gain.value = FLANGER_DEPTH_SECONDS;
  const flangerFeedback = ctx.createGain();
  flangerFeedback.gain.value = FLANGER_FEEDBACK;
  flangerLfo.connect(flangerDepth);
  flangerDepth.connect(flangerDelay.delayTime);
  flangerInput.connect(flangerDelay);
  flangerDelay.connect(flangerFeedback);
  flangerFeedback.connect(flangerDelay);
  flangerDelay.connect(wet);
  flangerLfo.start();

  // Phaser: all-pass stages swept together. (No feedback: a cycle without a DelayNode in it
  // renders silence in Web Audio.)
  const phaserInput = input();
  const phaserLfo = ctx.createOscillator();
  phaserLfo.type = 'sine';
  const phaserDepth = ctx.createGain();
  phaserDepth.gain.value = PHASER_DEPTH_HZ;
  phaserLfo.connect(phaserDepth);
  const stages: BiquadFilterNode[] = [];
  let previous: AudioNode = phaserInput;
  for (let i = 0; i < PHASER_STAGES; i++) {
    const stage = ctx.createBiquadFilter();
    stage.type = 'allpass';
    stage.frequency.value = PHASER_BASE_HZ;
    stage.Q.value = Math.SQRT1_2;
    phaserDepth.connect(stage.frequency);
    previous.connect(stage);
    previous = stage;
    stages.push(stage);
  }
  previous.connect(wet);
  phaserLfo.start();

  // Reverb: a synthetic room.
  const reverbInput = input();
  const convolver = ctx.createConvolver();
  convolver.buffer = reverbImpulse(ctx);
  reverbInput.connect(convolver);
  convolver.connect(wet);

  const fx: ChannelFx = {
    ctx,
    dry,
    wet,
    echo: { input: echoInput, delay: echoDelay, feedback: echoFeedback, damp: echoDamp },
    flanger: { input: flangerInput, delay: flangerDelay, lfo: flangerLfo, depth: flangerDepth, feedback: flangerFeedback },
    phaser: { input: phaserInput, stages, lfo: phaserLfo, depth: phaserDepth },
    reverb: { input: reverbInput, convolver },
    settings: { ...DEFAULT_FX },
    bpm,
  };
  applyTempo(fx);
  return fx;
}

/** Selects an effect (or none) and its beats and amount. */
export function setFx(fx: ChannelFx, settings: FxSettings): void {
  fx.settings = { ...settings };
  const { ctx } = fx;
  const inputs: Record<FxType, GainNode> = {
    echo: fx.echo.input,
    flanger: fx.flanger.input,
    phaser: fx.phaser.input,
    reverb: fx.reverb.input,
  };
  for (const [type, input] of Object.entries(inputs) as [FxType, GainNode][]) {
    glide(input.gain, type === settings.type ? 1 : 0, ctx, SMOOTHING);
  }
  const amount = clamp(settings.amount, 0, 1);
  // Equal-power dry/wet; with no effect the dry signal passes at unity.
  const on = settings.type !== null;
  glide(fx.dry.gain, on ? Math.cos((amount * Math.PI) / 2) : 1, ctx, SMOOTHING);
  glide(fx.wet.gain, on ? Math.sin((amount * Math.PI) / 2) : 0, ctx, SMOOTHING);
  glide(fx.echo.feedback.gain, ECHO_FEEDBACK_BASE + ECHO_FEEDBACK_RANGE * amount, ctx, SMOOTHING);
  applyTempo(fx);
}

/** The deck's playing tempo (track BPM × rate): echo delay and sweep rates follow it. */
export function setFxTempo(fx: ChannelFx, bpm: number): void {
  if (!(bpm > 0)) return;
  fx.bpm = bpm;
  applyTempo(fx);
}

function applyTempo(fx: ChannelFx): void {
  const { beats } = fx.settings;
  const { ctx } = fx;
  glide(fx.echo.delay.delayTime, echoDelaySeconds(beats, fx.bpm), ctx, DELAY_SMOOTHING);
  glide(fx.flanger.lfo.frequency, lfoHz(beats, fx.bpm), ctx, SMOOTHING);
  glide(fx.phaser.lfo.frequency, lfoHz(beats, fx.bpm), ctx, SMOOTHING);
}

function glide(param: AudioParam, value: number, ctx: BaseAudioContext, timeConstant: number): void {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, timeConstant);
}

/** Decaying noise, a different take per channel; seeded so renders repeat. */
function reverbImpulse(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.round(REVERB_SECONDS * ctx.sampleRate);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const decayPerSecond = Math.log(10) * (REVERB_DECAY_DB / 20) / REVERB_SECONDS;
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let seed = 12345 + channel * 777;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = seed / 0xffffffff - 0.5;
      data[i] = noise * Math.exp((-i / ctx.sampleRate) * decayPerSecond);
    }
  }
  return buffer;
}
