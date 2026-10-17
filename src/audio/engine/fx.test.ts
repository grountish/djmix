import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { echoDelaySeconds, lfoHz, setFx, setFxTempo } from './fx';
import { createMixGraph, getChannelFx, type MixGraph } from './mixGraph';

const SAMPLE_RATE = 48000;
/** The impulse goes in after the parameter glides from the setup have settled. */
const IMPULSE_AT = 0.2;

async function renderImpulse(configure: (graph: MixGraph) => void, seconds = 2): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: seconds * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
  const graph = createMixGraph(ctx);
  configure(graph);
  const impulse = ctx.createBuffer(1, 16, SAMPLE_RATE);
  impulse.getChannelData(0)[0] = 1;
  const source = ctx.createBufferSource();
  source.buffer = impulse;
  source.connect(graph.decks.A.input);
  source.start(IMPULSE_AT);
  return (await ctx.startRendering()).getChannelData(0);
}

function rms(out: Float32Array, from: number, to: number): number {
  const a = Math.round(from * SAMPLE_RATE);
  const b = Math.round(to * SAMPLE_RATE);
  let sum = 0;
  for (let i = a; i < b; i++) sum += out[i] * out[i];
  return Math.sqrt(sum / (b - a));
}

const around = (out: Float32Array, t: number) => rms(out, t - 0.02, t + 0.02);
/** Residual the channel itself leaves after an impulse (the filters' slow tails), well under any repeat. */
const SILENCE = 2e-4;

describe('channel effects', () => {
  it('pass the dry signal untouched and add nothing while off', async () => {
    const out = await renderImpulse((graph) => getChannelFx(graph, 'A'));
    expect(around(out, IMPULSE_AT)).toBeGreaterThan(0.01);
    expect(rms(out, IMPULSE_AT + 0.05, 2)).toBeLessThan(SILENCE);
  });

  it('echo repeats on the beat and decays', async () => {
    const out = await renderImpulse((graph) => {
      const fx = getChannelFx(graph, 'A');
      setFxTempo(fx, 120); // one beat = 0.5 s
      setFx(fx, { type: 'echo', beats: 1, amount: 1 });
    });
    const first = around(out, IMPULSE_AT + 0.5);
    const second = around(out, IMPULSE_AT + 1.0);
    const third = around(out, IMPULSE_AT + 1.5);
    expect(first).toBeGreaterThan(0.001);
    expect(second).toBeGreaterThan(0.3 * first);
    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);
    // Silence between the repeats.
    expect(rms(out, IMPULSE_AT + 0.1, IMPULSE_AT + 0.45)).toBeLessThan(SILENCE);
    expect(rms(out, IMPULSE_AT + 0.55, IMPULSE_AT + 0.95)).toBeLessThan(SILENCE);
  });

  it('echo follows the deck tempo', async () => {
    const out = await renderImpulse((graph) => {
      const fx = getChannelFx(graph, 'A');
      setFx(fx, { type: 'echo', beats: 1, amount: 0.5 });
      setFxTempo(fx, 60); // one beat = 1 s
    });
    expect(around(out, IMPULSE_AT + 0.5)).toBeLessThan(SILENCE);
    expect(around(out, IMPULSE_AT + 1.0)).toBeGreaterThan(0.001);
  });

  it('a lower amount means a shorter tail', async () => {
    const tail = async (amount: number) => {
      const out = await renderImpulse((graph) => {
        const fx = getChannelFx(graph, 'A');
        setFxTempo(fx, 120);
        setFx(fx, { type: 'echo', beats: 0.5, amount });
      });
      return around(out, IMPULSE_AT + 1.5);
    };
    expect(await tail(0.3)).toBeLessThan(await tail(1));
  });

  it('flanger, phaser and reverb each change the signal after the impulse', async () => {
    const dry = await renderImpulse((graph) => getChannelFx(graph, 'A'), 1);
    for (const type of ['flanger', 'phaser', 'reverb'] as const) {
      const wet = await renderImpulse((graph) => {
        const fx = getChannelFx(graph, 'A');
        setFx(fx, { type, beats: 4, amount: 0.8 });
      }, 1);
      let maxDiff = 0;
      for (let i = Math.round(IMPULSE_AT * SAMPLE_RATE); i < Math.round((IMPULSE_AT + 0.3) * SAMPLE_RATE); i++) {
        maxDiff = Math.max(maxDiff, Math.abs(wet[i] - dry[i]));
      }
      expect(maxDiff, type).toBeGreaterThan(1e-3);
    }
  });

  it('maps beats to seconds and sweep rates', () => {
    expect(echoDelaySeconds(0.5, 120)).toBeCloseTo(0.25);
    expect(echoDelaySeconds(0.75, 128)).toBeCloseTo(0.3515625);
    expect(echoDelaySeconds(16, 60)).toBe(4);
    expect(lfoHz(4, 120)).toBeCloseTo(0.5);
    expect(lfoHz(1, 60)).toBeCloseTo(1);
  });
});
