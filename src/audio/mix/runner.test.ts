import * as webAudio from 'node-web-audio-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeAudio } from '../analysis/analyzeAudio';
import { BUTTERWORTH4_Q, filtfilt, lowpass } from '../analysis/dsp';
import { synthesizeTrack, type SyntheticSection } from '../analysis/syntheticTrack';
import type { AudioAnalysis } from '../analysis/types';
import { constantClock } from '../analysis/beatClock';
import { createOfflineMix } from '../engine/offlineMix';
import { createStretchNode } from '../engine/stretch';
import { planTransition, type TransitionPlan } from './planner';
import { renderWithRunner, TransitionRunner } from './runner';
import { trackClock } from './trackClock';

const SAMPLE_RATE = 44100;
const FULL = { kick: true, clap: true, hats: true, bass: true, chords: true };
// Both test tracks share the same chords; pin the key so this tests the runner, not detection.
const A_MINOR = { tonic: 9, mode: 'minor', camelot: '8A', confidence: 1, source: 'tag' } as const;

beforeAll(() => {
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= webAudio.AudioWorkletNode;
});

function track(bpm: number, sections: SyntheticSection[]): { channels: Float32Array[]; analysis: AudioAnalysis } {
  const synth = synthesizeTrack({ bpm, firstDownbeat: 0.25, sections });
  const channels = synth.channels.map((c) => c.map((v) => v * 0.5));
  return { channels, analysis: { ...analyzeAudio(channels, SAMPLE_RATE), key: A_MINOR } };
}

/** Signed distance between two beat phases, in seconds. */
function phase(time: number, beat0: number, period: number): number {
  return ((((time - beat0) % period) + period * 1.5) % period) - period / 2;
}

describe('transition runner', () => {
  it('beat-locks the incoming track, swaps the basslines and returns to native tempo', async () => {
    const outgoing = track(124, [
      { bars: 8, kick: true, hats: true },
      { bars: 16, ...FULL },
      { bars: 16, kick: true, hats: true, bass: true, chords: true },
    ]);
    const incoming = track(128, [
      { bars: 16, kick: true, hats: true },
      { bars: 16, ...FULL },
      { bars: 8, kick: true, hats: true },
    ]);

    const seconds = 70;
    const ctx = new webAudio.OfflineAudioContext({
      numberOfChannels: 4,
      length: seconds * SAMPLE_RATE,
      sampleRate: SAMPLE_RATE,
    });
    const mix = createOfflineMix(ctx, ctx.createGain(), createStretchNode);
    // Channels: 0/1 = incoming/outgoing before the EQ (timing), 2/3 = after their faders (levels).
    const taps = ctx.createChannelMerger(4);
    mix.graph.decks.B.input.connect(taps, 0, 0);
    mix.graph.decks.A.input.connect(taps, 0, 1);
    mix.graph.decks.B.fader.connect(taps, 0, 2);
    mix.graph.decks.A.fader.connect(taps, 0, 3);
    taps.connect(ctx.destination);

    const toBuffer = (channels: Float32Array[]) => {
      const buffer = ctx.createBuffer(2, channels[0].length, SAMPLE_RATE);
      channels.forEach((c, i) => buffer.getChannelData(i).set(c));
      return buffer;
    };
    await mix.decks.A.load(toBuffer(outgoing.channels));
    await mix.decks.B.load(toBuffer(incoming.channels));
    mix.decks.A.setKeyLock(true);
    mix.decks.A.seek(30);
    mix.decks.A.play(0);

    const plan = planTransition({
      outgoing: { analysis: outgoing.analysis, trackTime: 30, rate: 1, semitones: 0 },
      incoming: { analysis: incoming.analysis },
    });
    expect(plan.kind).toBe('blend');
    expect(plan.overlapBars).toBe(16);
    expect(plan.outgoingStartBar).toBe(24);
    // Cued one phrase before its drop, so the drop lands on the bass swap (bar 8 of 16).
    expect(plan.incomingStartBar).toBe(8);
    expect(plan.bassSwapBar).toBe(8);

    const events: Record<string, number> = {};
    const at = (name: string) => () => (events[name] = ctx.currentTime);
    const runner = new TransitionRunner(
      ctx,
      mix.graph,
      { id: 'A', player: mix.decks.A, clock: trackClock(outgoing.analysis) },
      { id: 'B', player: mix.decks.B, clock: trackClock(incoming.analysis) },
      plan,
      { onIncomingStarted: at('started'), onOutgoingStopped: at('stopped'), onFinished: at('finished') },
    );
    runner.start();

    // The controls can show the automation: before the overlap the incoming deck is held
    // silent with its lows killed, the outgoing deck untouched.
    const before = runner.laneValues(runner.incomingStart - 1);
    expect(runner.incomingStarted(runner.incomingStart - 1)).toBe(false);
    expect(before.incoming).toMatchObject({ fader: 0, low: -Infinity });
    expect(before.outgoing).toMatchObject({ fader: 1, low: 0, filter: 0 });

    const out = await renderWithRunner(ctx, runner, [mix.decks.A, mix.decks.B]);
    expect(runner.finished).toBe(true);
    expect(mix.decks.A.isPlaying).toBe(false);
    expect(events.started).toBeGreaterThanOrEqual(runner.incomingStart);
    expect(events.started).toBeLessThan(runner.incomingStart + 0.1);
    expect(events.stopped).toBeGreaterThanOrEqual(runner.overlapEnd);
    expect(events.finished).toBeGreaterThanOrEqual(runner.finishTime);

    // After the overlap the incoming deck is at unity and the outgoing one faded out.
    const after = runner.laneValues(runner.overlapEnd + 1);
    expect(after.incoming).toMatchObject({ fader: 1, low: 0, mid: 0, high: 0 });
    expect(after.outgoing.fader).toBe(0);

    const slice = (channel: number, from: number, to: number) =>
      out.getChannelData(channel).slice(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));

    // Both decks play the overlap at the meeting tempo with their kicks on the same beats.
    const from = runner.incomingStart + 1;
    const to = runner.overlapEnd - 1;
    const inc = analyzeAudio([slice(0, from, to)], SAMPLE_RATE);
    const outg = analyzeAudio([slice(1, from, to)], SAMPLE_RATE);
    expect(inc.bpm).toBeCloseTo(plan.tempo.meetBpm, 1);
    expect(outg.bpm).toBeCloseTo(plan.tempo.meetBpm, 1);
    expect(Math.abs(phase(inc.firstBeatTime, outg.firstBeatTime, 60 / plan.tempo.meetBpm))).toBeLessThan(0.002);

    // Incoming phrase lines land on outgoing phrase lines: incoming bar 8 at outgoing bar 24.
    expect(runner.incomingStart).toBeCloseTo(runner.outgoingBeatTime(24 * 4)!, 6);

    // One deck owns the low end at a time: before the swap only the outgoing bass and kick
    // sound, after it only the incoming kick (both decks play kicks throughout the overlap).
    const lowLevel = (channel: number, startBar: number, endBar: number) => {
      const t0 = runner.outgoingBeatTime((24 + startBar) * 4)!;
      const t1 = runner.outgoingBeatTime((24 + endBar) * 4)!;
      const low = filtfilt(slice(channel, t0, t1), BUTTERWORTH4_Q.map((q) => lowpass(150, SAMPLE_RATE, q)));
      return 10 * Math.log10(low.reduce((s, v) => s + v * v, 0) / low.length + 1e-12);
    };
    // (The killed deck still leaks its mid band's bottom octave around the 200 Hz crossover.)
    const swap = plan.bassSwapBar;
    expect(lowLevel(2, 0, swap - 1) - lowLevel(3, 0, swap - 1)).toBeLessThan(-24);
    expect(lowLevel(3, swap + 1, 12) - lowLevel(2, swap + 1, 12)).toBeLessThan(-24);

    // The incoming track ends the ramp at its own tempo.
    const tail = analyzeAudio([slice(0, runner.finishTime + 0.5, seconds - 0.5)], SAMPLE_RATE);
    expect(Math.abs(tail.bpm - 128)).toBeLessThan(0.2);
  }, 180000);

  it('loops the outgoing track under the blend when it has too few bars left', async () => {
    // 32 bars: by bar 18 only 8 bars of blend would fit, so the last kick phrase (bars 25–32)
    // repeats once under a 16-bar blend.
    const outgoing = track(124, [
      { bars: 8, kick: true, hats: true },
      { bars: 16, ...FULL },
      { bars: 8, kick: true, hats: true, bass: true, chords: true },
    ]);
    const incoming = track(128, [
      { bars: 16, kick: true, hats: true },
      { bars: 16, ...FULL },
      { bars: 8, kick: true, hats: true },
    ]);

    const seconds = 90;
    const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 2, length: seconds * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
    const mix = createOfflineMix(ctx, ctx.createGain(), createStretchNode);
    // Channels: 0 = incoming, 1 = outgoing, both before the EQ.
    const taps = ctx.createChannelMerger(2);
    mix.graph.decks.B.input.connect(taps, 0, 0);
    mix.graph.decks.A.input.connect(taps, 0, 1);
    taps.connect(ctx.destination);
    const toBuffer = (channels: Float32Array[]) => {
      const buffer = ctx.createBuffer(2, channels[0].length, SAMPLE_RATE);
      channels.forEach((c, i) => buffer.getChannelData(i).set(c));
      return buffer;
    };
    await mix.decks.A.load(toBuffer(outgoing.channels));
    await mix.decks.B.load(toBuffer(incoming.channels));
    mix.decks.A.setKeyLock(true);
    mix.decks.A.seek(35);
    mix.decks.A.play(0);

    const plan = planTransition({
      outgoing: { analysis: outgoing.analysis, trackTime: 35, rate: 1, semitones: 0 },
      incoming: { analysis: incoming.analysis },
    });
    expect(plan.kind).toBe('blend');
    expect(plan.overlapBars).toBe(16);
    expect(plan.outgoingStartBar).toBe(24);
    expect(plan.outgoingLoop).toEqual({ startBar: 24, bars: 8 });

    const events: Record<string, number> = {};
    const at = (name: string) => () => (events[name] = ctx.currentTime);
    const runner = new TransitionRunner(
      ctx,
      mix.graph,
      { id: 'A', player: mix.decks.A, clock: trackClock(outgoing.analysis) },
      { id: 'B', player: mix.decks.B, clock: trackClock(incoming.analysis) },
      plan,
      { onOutgoingStopped: at('stopped'), onFinished: at('finished') },
    );
    runner.start();
    // The looped timeline runs past the track's 32 bars, one beat after another.
    const beat = (n: number) => runner.outgoingBeatTime(n)!;
    expect(beat(40 * 4)).toBeGreaterThan(beat(32 * 4));
    expect(beat(32 * 4 + 1) - beat(32 * 4)).toBeCloseTo(beat(31 * 4 + 1) - beat(31 * 4), 4);

    const out = await renderWithRunner(ctx, runner, [mix.decks.A, mix.decks.B]);
    expect(runner.finished).toBe(true);
    expect(mix.decks.A.isPlaying).toBe(false);
    expect(events.stopped).toBeGreaterThanOrEqual(runner.overlapEnd);

    const slice = (channel: number, from: number, to: number) =>
      out.getChannelData(channel).slice(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));
    const db = (samples: Float32Array) => 10 * Math.log10(samples.reduce((s, v) => s + v * v, 0) / samples.length + 1e-12);

    // Past its last bar the outgoing deck still plays (the loop), then stops with the blend.
    const firstPass = slice(1, beat(24 * 4), beat(32 * 4));
    const secondPass = slice(1, beat(32 * 4), beat(40 * 4));
    expect(db(secondPass)).toBeGreaterThan(db(firstPass) - 3);
    expect(db(slice(1, runner.overlapEnd + 0.3, runner.overlapEnd + 2))).toBeLessThan(db(firstPass) - 40);

    // The repeat is the same phrase: its envelope follows the first pass almost exactly.
    const envelope = (samples: Float32Array) => {
      const hop = Math.round(0.01 * SAMPLE_RATE);
      const frames = Math.floor(samples.length / hop);
      return Float64Array.from({ length: frames }, (_, f) => {
        let sum = 0;
        for (let i = f * hop; i < (f + 1) * hop; i++) sum += samples[i] * samples[i];
        return Math.sqrt(sum / hop);
      });
    };
    const correlation = (a: Float64Array, b: Float64Array) => {
      const n = Math.min(a.length, b.length);
      const mean = (x: Float64Array) => x.subarray(0, n).reduce((s, v) => s + v, 0) / n;
      const ma = mean(a);
      const mb = mean(b);
      let num = 0;
      let da = 0;
      let dbb = 0;
      for (let i = 0; i < n; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        dbb += (b[i] - mb) ** 2;
      }
      return num / Math.sqrt(da * dbb);
    };
    expect(correlation(envelope(firstPass), envelope(secondPass))).toBeGreaterThan(0.9);

    // Both decks keep the meeting tempo with their kicks together through the looped bars.
    const from = beat(32 * 4) + 0.5;
    const to = runner.overlapEnd - 0.5;
    const inc = analyzeAudio([slice(0, from, to)], SAMPLE_RATE);
    const outg = analyzeAudio([slice(1, from, to)], SAMPLE_RATE);
    expect(inc.bpm).toBeCloseTo(plan.tempo.meetBpm, 1);
    expect(outg.bpm).toBeCloseTo(plan.tempo.meetBpm, 1);
    expect(Math.abs(phase(inc.firstBeatTime, outg.firstBeatTime, 60 / plan.tempo.meetBpm))).toBeLessThan(0.002);
  }, 180000);

  it('holds the incoming intro on a loop while it fades in (loop style), then plays on into its drop', async () => {
    const outgoing = track(124, [
      { bars: 8, kick: true, hats: true },
      { bars: 24, ...FULL },
      { bars: 16, kick: true, hats: true, bass: true, chords: true },
    ]);
    // An 8-bar intro: a blend would bring the drop in a quarter of the way into the overlap.
    const incoming = track(126, [
      { bars: 8, kick: true, hats: true },
      { bars: 16, ...FULL },
      { bars: 8, kick: true, hats: true },
    ]);

    const seconds = 95;
    const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 2, length: seconds * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
    const mix = createOfflineMix(ctx, ctx.createGain(), createStretchNode);
    // Channels: 0 = incoming, 1 = outgoing, both before the EQ.
    const taps = ctx.createChannelMerger(2);
    mix.graph.decks.B.input.connect(taps, 0, 0);
    mix.graph.decks.A.input.connect(taps, 0, 1);
    taps.connect(ctx.destination);
    const toBuffer = (channels: Float32Array[]) => {
      const buffer = ctx.createBuffer(2, channels[0].length, SAMPLE_RATE);
      channels.forEach((c, i) => buffer.getChannelData(i).set(c));
      return buffer;
    };
    await mix.decks.A.load(toBuffer(outgoing.channels));
    await mix.decks.B.load(toBuffer(incoming.channels));
    mix.decks.A.setKeyLock(true);
    mix.decks.A.seek(12);
    mix.decks.A.play(0);

    const plan = planTransition({
      outgoing: { analysis: outgoing.analysis, trackTime: 12, rate: 1, semitones: 0 },
      incoming: { analysis: incoming.analysis },
      style: 'loop',
    });
    expect(plan.kind).toBe('blend');
    expect(plan.overlapBars).toBe(32);
    expect(plan.incomingStartBar).toBe(0);
    expect(plan.incomingLoop).toEqual({ startBar: 0, bars: 8, repeats: 1 });
    // The intro plays twice, so the drop (track bar 8) lands on the swap at overlap bar 16.
    expect(plan.bassSwapBar).toBe(16);
    expect(plan.warnings).toEqual([]);

    const runner = new TransitionRunner(
      ctx,
      mix.graph,
      { id: 'A', player: mix.decks.A, clock: trackClock(outgoing.analysis) },
      { id: 'B', player: mix.decks.B, clock: trackClock(incoming.analysis) },
      plan,
    );
    runner.start();
    expect(runner.lockAbandoned).toBe(false);
    const out = await renderWithRunner(ctx, runner, [mix.decks.A, mix.decks.B]);
    expect(runner.finished).toBe(true);
    expect(runner.finishTime).toBeLessThan(seconds - 1);

    const start = plan.outgoingStartBar;
    const bar = (n: number) => runner.outgoingBeatTime((start + n) * 4)!;
    const slice = (channel: number, from: number, to: number) =>
      out.getChannelData(channel).slice(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));
    const db = (samples: Float32Array) => 10 * Math.log10(samples.reduce((s, v) => s + v * v, 0) / samples.length + 1e-12);

    // Overlap bars 0–8 and 8–16 are the intro twice; the drop (bass, clap, chords) comes after.
    const firstPass = slice(0, bar(0) + 0.1, bar(8) - 0.1);
    const secondPass = slice(0, bar(8) + 0.1, bar(16) - 0.1);
    const drop = slice(0, bar(16) + 0.1, bar(24) - 0.1);
    expect(Math.abs(db(secondPass) - db(firstPass))).toBeLessThan(1.5);
    expect(db(drop)).toBeGreaterThan(db(firstPass) + 3);

    // Through the jump back the incoming kicks stay on the outgoing ones.
    for (const [from, to] of [
      [bar(8) + 0.5, bar(16) - 0.5],
      [bar(16) + 0.5, bar(24) - 0.5],
    ]) {
      const inc = analyzeAudio([slice(0, from, to)], SAMPLE_RATE);
      const outg = analyzeAudio([slice(1, from, to)], SAMPLE_RATE);
      expect(inc.bpm).toBeCloseTo(plan.tempo.meetBpm, 1);
      expect(Math.abs(phase(inc.firstBeatTime, outg.firstBeatTime, 60 / plan.tempo.meetBpm))).toBeLessThan(0.002);
    }
  }, 180000);

  it("doesn't chase beat-lock rates when the two beat clocks disagree", async () => {
    // 120 → 123 BPM meeting at 121.5; the incoming clock is either right or miscounts beats
    // as 8/7 of its tempo (the drift tracker's old off-beat slip).
    const lockFor = async (incomingClockBpm: number) => {
      const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 2, length: SAMPLE_RATE, sampleRate: SAMPLE_RATE });
      const mix = createOfflineMix(ctx);
      const silence = ctx.createBuffer(2, 120 * SAMPLE_RATE, SAMPLE_RATE);
      await mix.decks.A.load(silence);
      await mix.decks.B.load(silence);
      mix.decks.A.play(0);
      const plan = {
        kind: 'blend',
        tempo: { canBlend: true, meetBpm: 121.5, outgoingRate: 121.5 / 120, incomingRate: 121.5 / 123, outgoingRampBars: 0, incomingRampBars: 2 },
        overlapBars: 8,
        outgoingStartBar: 8,
        outgoingRampStartBar: 8,
        incomingStartBar: 0,
        bassSwapBar: 4,
        incomingSemitones: 0,
        harmonic: { score: 1, outgoingKey: '8A', incomingKey: '8A' },
        lanes: [],
        warnings: [],
      } satisfies TransitionPlan;
      const runner = new TransitionRunner(
        ctx,
        mix.graph,
        { id: 'A', player: mix.decks.A, clock: constantClock(0, 60 / 120) },
        { id: 'B', player: mix.decks.B, clock: constantClock(0, 60 / incomingClockBpm) },
        plan,
      );
      runner.start();
      return { abandoned: runner.lockAbandoned, rate: mix.decks.B.currentRate };
    };

    expect(await lockFor(123)).toEqual({ abandoned: false, rate: expect.closeTo(121.5 / 123, 6) });
    // Chasing the broken clock would play the incoming track at 121.5 / 140.6: 14% slow.
    expect(await lockFor((123 * 8) / 7)).toEqual({ abandoned: true, rate: expect.closeTo(121.5 / 123, 6) });
  });
});
