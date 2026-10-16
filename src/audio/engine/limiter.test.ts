import * as webAudio from 'node-web-audio-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLimiter, LIMITER_CEILING_DB } from './limiter';

const SAMPLE_RATE = 44100;
const LOOKAHEAD = Math.round(0.005 * SAMPLE_RATE);
const CEILING = Math.pow(10, LIMITER_CEILING_DB / 20);

beforeAll(() => {
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= webAudio.AudioWorkletNode;
});

async function limit(signal: Float32Array): Promise<Float32Array> {
  const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 2, length: signal.length, sampleRate: SAMPLE_RATE });
  const limiter = await createLimiter(ctx);
  const buffer = ctx.createBuffer(1, signal.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(signal);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(limiter);
  limiter.connect(ctx.destination);
  source.start(0);
  return (await ctx.startRendering()).getChannelData(0);
}

function tone(seconds: number, amplitude: (t: number) => number): Float32Array {
  const x = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < x.length; i++) {
    const t = i / SAMPLE_RATE;
    x[i] = amplitude(t) * Math.sin(2 * Math.PI * 100 * t);
  }
  return x;
}

describe('lookahead limiter', () => {
  it('never lets a sample past the ceiling', async () => {
    // Kick-like bursts four times over full scale on a quiet bed.
    const signal = tone(2, (t) => (t % 0.5 < 0.08 ? 4 : 0.3));
    const out = await limit(signal);
    const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(peak).toBeGreaterThan(CEILING * 0.95);
  });

  it('passes quiet audio untouched, only delayed by the lookahead', async () => {
    const signal = tone(1, () => 0.5);
    const out = await limit(signal);
    let worst = 0;
    for (let i = 0; i + LOOKAHEAD < out.length; i++) worst = Math.max(worst, Math.abs(out[i + LOOKAHEAD] - signal[i]));
    expect(worst).toBeLessThan(1e-6);
  });

  it('recovers after a loud passage', async () => {
    const signal = tone(2, (t) => (t < 0.5 ? 4 : 0.5));
    const out = await limit(signal);
    // Half a second after the loud part ends the quiet bed is back to (nearly) full level.
    const from = Math.round(1.2 * SAMPLE_RATE);
    let peak = 0;
    for (let i = from; i < from + SAMPLE_RATE / 10; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeGreaterThan(0.5 * 0.95);
  });
});
