import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { RealFFT } from '../analysis/dsp';
import { createMixGraph, type MixGraph } from './mixGraph';

const SAMPLE_RATE = 44100;
const FFT_SIZE = 32768;

/** Magnitude response (dB) of deck A's channel, from its impulse response after the fader. */
async function channelResponse(configure: (graph: MixGraph) => void): Promise<(hz: number) => number> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: FFT_SIZE, sampleRate: SAMPLE_RATE });
  const graph = createMixGraph(ctx, ctx.createGain());
  graph.decks.A.fader.connect(ctx.destination);
  configure(graph);

  const impulse = ctx.createBuffer(1, FFT_SIZE, SAMPLE_RATE);
  impulse.getChannelData(0)[0] = 1;
  const source = ctx.createBufferSource();
  source.buffer = impulse;
  source.connect(graph.decks.A.input);
  source.start(0);

  const response = (await ctx.startRendering()).getChannelData(0);
  const re = new Float64Array(FFT_SIZE / 2 + 1);
  const im = new Float64Array(FFT_SIZE / 2 + 1);
  new RealFFT(FFT_SIZE).forward(response, re, im);
  return (hz) => {
    const bin = Math.round((hz * FFT_SIZE) / SAMPLE_RATE);
    return 20 * Math.log10(Math.hypot(re[bin], im[bin]) + 1e-12);
  };
}

const FREQUENCIES = [30, 60, 100, 150, 200, 300, 1000, 2000, 2500, 3000, 6000, 10000, 16000];

describe('3-band isolator', () => {
  it('is flat when every band is at unity and the filter is off', async () => {
    const db = await channelResponse(() => {});
    for (const hz of FREQUENCIES) expect(Math.abs(db(hz))).toBeLessThan(0.1);
  });

  it('kills the low band without touching mids and highs', async () => {
    const db = await channelResponse((graph) => {
      graph.decks.A.eq.low.gain.value = 0;
    });
    expect(db(60)).toBeLessThan(-40);
    expect(db(30)).toBeLessThan(-40);
    expect(Math.abs(db(1000))).toBeLessThan(0.5);
    expect(Math.abs(db(10000))).toBeLessThan(0.1);
  });

  it('kills mids and highs independently', async () => {
    const noMid = await channelResponse((graph) => {
      graph.decks.A.eq.mid.gain.value = 0;
    });
    expect(noMid(700)).toBeLessThan(-30);
    expect(Math.abs(noMid(40))).toBeLessThan(0.5);

    const noHigh = await channelResponse((graph) => {
      graph.decks.A.eq.high.gain.value = 0;
    });
    expect(noHigh(10000)).toBeLessThan(-40);
    expect(Math.abs(noHigh(100))).toBeLessThan(0.1);
  });
});

describe('DJ filter', () => {
  it('sweeps a low-pass down and a high-pass up', async () => {
    // Knob setters glide; the impulse arrives at t=0, so set the end-of-sweep values directly.
    const lowpassed = await channelResponse((graph) => {
      graph.decks.A.filter.lowpass.frequency.value = 150;
    });
    expect(lowpassed(2000)).toBeLessThan(-30);
    expect(Math.abs(lowpassed(50))).toBeLessThan(1);

    const highpassed = await channelResponse((graph) => {
      graph.decks.A.filter.highpass.frequency.value = 8000;
    });
    expect(highpassed(500)).toBeLessThan(-40);
    expect(Math.abs(highpassed(16000))).toBeLessThan(1.5);
  });
});
