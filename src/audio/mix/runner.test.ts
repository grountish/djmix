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
    expect(plan.incomingStartBar).toBe(0);

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

    // Incoming phrase lines land on outgoing phrase lines: incoming bar 0 at outgoing bar 24.
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
    expect(tail.bpm).toBeCloseTo(128, 1);
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
