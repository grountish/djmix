import * as webAudio from 'node-web-audio-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeAudio } from '../analysis/analyzeAudio';
import { synthesizeTrack } from '../analysis/syntheticTrack';
import { createOfflineMix } from './offlineMix';
import { createStretchNode } from './stretch';

const SAMPLE_RATE = 44100;

beforeAll(() => {
  // The stretcher looks up AudioWorkletNode globally, as in a browser.
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= webAudio.AudioWorkletNode;
});

/** Mix whose output is deck A before the EQ (the crossovers delay lows by a few ms). */
function deckOnlyMix(ctx: OfflineAudioContext) {
  const mix = createOfflineMix(ctx, ctx.createGain(), createStretchNode);
  mix.graph.decks.A.input.connect(ctx.destination);
  return mix;
}

function offlineContext(seconds: number): OfflineAudioContext {
  return new webAudio.OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
}

function toBuffer(ctx: BaseAudioContext, channels: Float32Array[]): AudioBuffer {
  const buffer = ctx.createBuffer(channels.length, channels[0].length, SAMPLE_RATE);
  channels.forEach((channel, c) => buffer.getChannelData(c).set(channel));
  return buffer;
}

/** Signed distance between two beat phases, in seconds. */
function phaseError(time: number, expected: number, period: number): number {
  return ((((time - expected) % period) + period * 1.5) % period) - period / 2;
}

const house = synthesizeTrack({
  bpm: 124,
  firstDownbeat: 0.1,
  sections: [{ bars: 12, kick: true, clap: true, hats: true, bass: true, chords: true }],
});
const houseChannels = house.channels.map((c) => c.map((v) => v * 0.5));
const source = analyzeAudio(houseChannels, SAMPLE_RATE);

describe('key lock', () => {
  it('plays kicks on the deck anchors while stretched', async () => {
    const ctx = offlineContext(24);
    const mix = deckOnlyMix(ctx);
    const deck = mix.decks.A;
    await deck.load(toBuffer(ctx, houseChannels));
    deck.setKeyLock(true);
    deck.setRate(1.05);
    deck.play(0.5);
    await deck.settled();

    const out = await ctx.startRendering();
    const result = analyzeAudio([out.getChannelData(0), out.getChannelData(1)], SAMPLE_RATE);

    expect(result.bpm).toBeCloseTo(source.bpm * 1.05, 2);
    const expectedBeat = 0.5 + source.firstBeatTime / 1.05;
    expect(Math.abs(phaseError(result.firstBeatTime, expectedBeat, 60 / result.bpm))).toBeLessThan(0.001);
  });

  it('switches key lock on mid-play without a gap or a beat slip', async () => {
    const ctx = offlineContext(24);
    const mix = deckOnlyMix(ctx);
    const deck = mix.decks.A;
    await deck.load(toBuffer(ctx, houseChannels));
    deck.setRate(1.05);
    deck.play(0.5);
    ctx.suspend(6).then(async () => {
      deck.setKeyLock(true);
      await deck.settled();
      ctx.resume();
    });

    const out = await ctx.startRendering();
    const left = out.getChannelData(0);

    // Loudness in 50 ms windows around the handover never collapses.
    const rms = (from: number) => {
      let sum = 0;
      const start = Math.round(from * SAMPLE_RATE);
      const length = Math.round(0.05 * SAMPLE_RATE);
      for (let i = start; i < start + length; i++) sum += left[i] * left[i];
      return Math.sqrt(sum / length);
    };
    const typical = rms(3);
    for (let t = 6; t < 6.6; t += 0.05) expect(rms(t)).toBeGreaterThan(0.2 * typical);

    // Beats after the switch still sit on the original timeline.
    const from = 8 * SAMPLE_RATE;
    const result = analyzeAudio([0, 1].map((c) => out.getChannelData(c).slice(from)), SAMPLE_RATE);
    const expectedBeat = 0.5 + source.firstBeatTime / 1.05 - 8;
    expect(Math.abs(phaseError(result.firstBeatTime, expectedBeat, 60 / result.bpm))).toBeLessThan(0.0015);
  });

  it('keeps pitch when stretched and shifts it by whole semitones', async () => {
    const tone = new Float32Array(SAMPLE_RATE * 8);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);

    const measure = async (semitones: number) => {
      const ctx = offlineContext(6);
      const mix = deckOnlyMix(ctx);
      const deck = mix.decks.A;
      await deck.load(toBuffer(ctx, [tone, tone]));
      deck.setKeyLock(true);
      deck.setRate(1.06);
      deck.setSemitones(semitones);
      deck.play(0.2);
      await deck.settled();
      const out = (await ctx.startRendering()).getChannelData(0);
      let crossings = 0;
      const from = 2 * SAMPLE_RATE;
      const to = 5 * SAMPLE_RATE;
      for (let i = from + 1; i < to; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++;
      return crossings / 3;
    };

    // Within 10 cents (a harmonic mix tolerates far more).
    const cents = (hz: number, target: number) => Math.abs(1200 * Math.log2(hz / target));
    expect(cents(await measure(0), 440)).toBeLessThan(10);
    expect(cents(await measure(1), 440 * Math.pow(2, 1 / 12))).toBeLessThan(10);
  });
});
