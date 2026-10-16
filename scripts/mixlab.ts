/**
 * Renders an automix transition between two audio files offline, writes it to a WAV and
 * prints how tight it was.
 *
 *   npm run mixlab -- <outgoing> <incoming> [--out mix.wav]
 */
import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { parseFile } from 'music-metadata';
import * as webAudio from 'node-web-audio-api';
import { analyzeAudio } from '../src/audio/analysis/analyzeAudio';
import { keyFromTag } from '../src/audio/analysis/key';
import type { AudioAnalysis } from '../src/audio/analysis/types';
import { attachLimiter } from '../src/audio/engine/limiter';
import { createOfflineMix } from '../src/audio/engine/offlineMix';
import { createStretchNode } from '../src/audio/engine/stretch';
import { describePlan } from '../src/audio/automixController';
import { planTransition } from '../src/audio/mix/planner';
import { summarizeTransition } from '../src/audio/mix/metrics';
import { renderWithRunner, TransitionRunner } from '../src/audio/mix/runner';
import { trackClock } from '../src/audio/mix/trackClock';

(globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= webAudio.AudioWorkletNode;

const SAMPLE_RATE = 44100;
/** Bars of the outgoing track played before its tempo ramp starts. */
const RUN_IN_BARS = 8;
const TAIL_SECONDS = 8;
const TARGET_LUFS = -11;

async function load(file: string): Promise<{ buffer: AudioBuffer; analysis: AudioAnalysis }> {
  const data = readFileSync(file);
  const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: SAMPLE_RATE });
  const buffer = await ctx.decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const analysis = analyzeAudio(channels, buffer.sampleRate);
  const tagged = keyFromTag((await parseFile(file, { skipCovers: true })).common.key as string | undefined);
  return { buffer, analysis: tagged ? { ...analysis, key: tagged } : analysis };
}

function writeWav(path: string, channels: Float32Array[], sampleRate: number): void {
  const frames = channels[0].length;
  const data = Buffer.alloc(44 + frames * channels.length * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + frames * channels.length * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels.length, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * channels.length * 2, 28);
  data.writeUInt16LE(channels.length * 2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(frames * channels.length * 2, 40);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channel[i])) * 32767), offset);
      offset += 2;
    }
  }
  writeFileSync(path, data);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : 'mixlab.wav';
  const [outgoingFile, incomingFile] = args.filter((_, i) => outIndex < 0 || (i !== outIndex && i !== outIndex + 1));
  if (!outgoingFile || !incomingFile) throw new Error('Usage: mixlab <outgoing> <incoming> [--out mix.wav]');

  const outgoing = await load(outgoingFile);
  const incoming = await load(incomingFile);
  const clockOut = trackClock(outgoing.analysis);

  // Plan once from the start to find the mix-out point, then begin a few bars before its ramp.
  const draft = planTransition({
    outgoing: { analysis: outgoing.analysis, trackTime: 0, rate: 1, semitones: 0 },
    incoming: { analysis: incoming.analysis },
  });
  const startTrackTime = Math.max(0, clockOut.timeOf((draft.outgoingRampStartBar - RUN_IN_BARS) * 4));
  const plan = planTransition({
    outgoing: { analysis: outgoing.analysis, trackTime: startTrackTime, rate: 1, semitones: 0 },
    incoming: { analysis: incoming.analysis },
  });
  console.log(describePlan(plan));

  // Long enough for the run-in, the overlap and the incoming ramp, generously estimated.
  const outgoingSeconds = clockOut.timeOf((plan.outgoingStartBar + plan.overlapBars) * 4) - startTrackTime;
  const rampSeconds = (plan.tempo.incomingRampBars * 4 * 60) / incoming.analysis.bpm;
  const seconds = Math.ceil(outgoingSeconds / Math.min(1, plan.tempo.outgoingRate) + rampSeconds + TAIL_SECONDS);

  // Channels: 0/1 master, 2/3 incoming/outgoing before the EQ, 4/5 after their faders.
  const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 6, length: seconds * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
  const taps = ctx.createChannelMerger(6);
  const masterOut = ctx.createChannelSplitter(2);
  masterOut.connect(taps, 0, 0);
  masterOut.connect(taps, 1, 1);
  taps.connect(ctx.destination);
  const mix = createOfflineMix(ctx, masterOut, createStretchNode);
  await attachLimiter(mix.graph, masterOut);
  mix.graph.decks.B.input.connect(taps, 0, 2);
  mix.graph.decks.A.input.connect(taps, 0, 3);
  mix.graph.decks.B.fader.connect(taps, 0, 4);
  mix.graph.decks.A.fader.connect(taps, 0, 5);

  await mix.decks.A.load(outgoing.buffer);
  await mix.decks.B.load(incoming.buffer);
  // Same loudness trim the app applies on load.
  for (const [id, track] of [['A', outgoing], ['B', incoming]] as const) {
    const trimDb = Math.max(-12, Math.min(6, TARGET_LUFS - track.analysis.loudness.integratedLufs));
    mix.graph.decks[id].input.gain.value = Math.pow(10, trimDb / 20);
  }
  mix.decks.A.setKeyLock(true);
  mix.decks.A.seek(startTrackTime);
  mix.decks.A.play(0);

  const runner = new TransitionRunner(
    ctx,
    mix.graph,
    { id: 'A', player: mix.decks.A, clock: clockOut },
    { id: 'B', player: mix.decks.B, clock: trackClock(incoming.analysis) },
    plan,
  );
  runner.start();
  const rendered = await renderWithRunner(ctx, runner, [mix.decks.A, mix.decks.B]);
  const channel = (c: number) => rendered.getChannelData(c);
  writeWav(outPath, [channel(0), channel(1)], SAMPLE_RATE);

  const report: Record<string, unknown> = { plan: describePlan(plan), wav: outPath, seconds };
  if (plan.overlapBars > 0) {
    const startBeat = plan.outgoingStartBar * 4;
    const overlapBeatTimes = Array.from({ length: plan.overlapBars * 4 }, (_, i) => runner.outgoingBeatTime(startBeat + i)!);
    // The bass handover ramps over the quarter beat before the swap downbeat.
    const swapBeat = plan.bassSwapBar * 4;
    const metrics = summarizeTransition({
      sampleRate: SAMPLE_RATE,
      timingTaps: { incoming: channel(2), outgoing: channel(3) },
      levelTaps: { incoming: channel(4), outgoing: channel(5) },
      master: [channel(0), channel(1)],
      overlapBeatTimes,
      overlapStart: runner.incomingStart,
      overlapEnd: runner.overlapEnd,
      allowedCollisionBeats: [swapBeat - 1, swapBeat],
    });
    report.beatAlignmentMs = {
      beats: metrics.alignment.summary.count,
      mean: +metrics.alignment.summary.meanMs.toFixed(2),
      median: +metrics.alignment.summary.medianMs.toFixed(2),
      p95: +metrics.alignment.summary.p95AbsMs.toFixed(2),
      max: +metrics.alignment.summary.maxAbsMs.toFixed(2),
    };
    report.lowBandCollisions = metrics.unexpectedCollisionBeats;
    if (process.env.MIXLAB_DEBUG) {
      console.log('aligned beats', JSON.stringify(metrics.alignment.beats.map((b) => [b.beat, +b.diffMs.toFixed(1)])));
      const { times, lufs } = metrics.loudness;
      const curve = times
        .map((t, i) => [t, lufs[i]] as const)
        .filter(([t]) => t >= runner.incomingStart - 8 && t <= runner.overlapEnd + 8 && Math.round(t * 10) % 10 === 0)
        .map(([t, l]) => `${(t - runner.incomingStart).toFixed(0)}s:${l.toFixed(1)}`);
      console.log('short-term LUFS around the overlap (s from start):', curve.join(' '));
    }
    report.loudnessDeviationLu = +metrics.loudnessDeviationLu.toFixed(2);
    report.checks = metrics.checks;
    report.pass = metrics.pass;
  }
  let peak = 0;
  for (const c of [0, 1]) for (const v of channel(c)) peak = Math.max(peak, Math.abs(v));
  report.masterPeakDb = +(20 * Math.log10(peak)).toFixed(2);
  report.outgoing = basename(outgoingFile);
  report.incoming = basename(incomingFile);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
