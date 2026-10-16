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
import { BUTTERWORTH4_Q, filtfilt, lowpass } from '../src/audio/analysis/dsp';
import { keyFromTag } from '../src/audio/analysis/key';
import type { AudioAnalysis } from '../src/audio/analysis/types';
import { attachLimiter } from '../src/audio/engine/limiter';
import { createOfflineMix } from '../src/audio/engine/offlineMix';
import { createStretchNode } from '../src/audio/engine/stretch';
import { describePlan } from '../src/audio/automixController';
import { planTransition } from '../src/audio/mix/planner';
import { renderWithRunner, TransitionRunner } from '../src/audio/mix/runner';
import { trackClock } from '../src/audio/mix/trackClock';

(globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= webAudio.AudioWorkletNode;

const SAMPLE_RATE = 44100;
/** Bars of the outgoing track played before its tempo ramp starts. */
const RUN_IN_BARS = 8;
const TAIL_SECONDS = 8;

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

/** Signed distance between two beat phases, in seconds. */
function phase(time: number, beat0: number, period: number): number {
  return ((((time - beat0) % period) + period * 1.5) % period) - period / 2;
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

  // Beat lock during the overlap: both decks' grids, measured on what they actually played.
  const slice = (c: number, from: number, to: number) =>
    channel(c).slice(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));
  const report: Record<string, unknown> = { plan: describePlan(plan), wav: outPath, seconds };
  if (plan.overlapBars > 0) {
    const from = runner.incomingStart + 0.5;
    const to = runner.overlapEnd - 0.5;
    const inc = analyzeAudio([slice(2, from, to)], SAMPLE_RATE);
    const out = analyzeAudio([slice(3, from, to)], SAMPLE_RATE);
    report.overlapBpm = { outgoing: +out.bpm.toFixed(3), incoming: +inc.bpm.toFixed(3), planned: +plan.tempo.meetBpm.toFixed(3) };
    report.beatOffsetMs = +(phase(inc.firstBeatTime, out.firstBeatTime, 60 / plan.tempo.meetBpm) * 1000).toFixed(2);

    // Per beat: where each deck's kick attack (50% of its rise) lands around the outgoing beat.
    const envelope = (c: number) => {
      const low = filtfilt(channel(c), BUTTERWORTH4_Q.map((q) => lowpass(150, SAMPLE_RATE, q)));
      const hop = 22;
      const env = new Float32Array(Math.floor(low.length / hop));
      for (let j = 0; j < env.length; j++) {
        let sum = 0;
        for (let i = j * hop; i < (j + 1) * hop; i++) sum += low[i] * low[i];
        env[j] = sum;
      }
      const smooth = new Float32Array(env.length);
      for (let j = 4; j < env.length - 4; j++) {
        let sum = 0;
        for (let k = -4; k <= 4; k++) sum += env[j + k];
        smooth[j] = sum / 9;
      }
      return { values: smooth, rate: SAMPLE_RATE / hop };
    };
    const onset = (env: { values: Float32Array; rate: number }, time: number, reach: number) => {
      const centre = Math.round(time * env.rate);
      const span = Math.round(reach * env.rate);
      let peak = centre - span;
      for (let j = centre - span; j <= centre + span; j++) if (env.values[j] > env.values[peak]) peak = j;
      let floor = env.values[peak];
      for (let j = peak - span; j <= peak; j++) floor = Math.min(floor, env.values[j]);
      if (env.values[peak] < 2 * floor + 1e-9) return null;
      const level = (floor + env.values[peak]) / 2;
      for (let j = peak; j > peak - span; j--) if (env.values[j - 1] < level) return (j - 0.5) / env.rate;
      return null;
    };
    const incomingEnv = envelope(2);
    const outgoingEnv = envelope(3);
    const offsets: number[] = [];
    const period = 60 / plan.tempo.meetBpm;
    for (let beat = plan.outgoingStartBar * 4; beat < (plan.outgoingStartBar + plan.overlapBars) * 4; beat++) {
      const time = runner.outgoingBeatTime(beat)!;
      const a = onset(outgoingEnv, time, period / 4);
      const b = onset(incomingEnv, time, period / 4);
      if (a !== null && b !== null) offsets.push((b - a) * 1000);
      if (process.env.MIXLAB_DEBUG) {
        const ms = (x: number | null) => (x === null ? '  -  ' : ((x - time) * 1000).toFixed(1).padStart(6));
        console.log(`beat ${beat}: outgoing ${ms(a)} incoming ${ms(b)}`);
      }
    }
    offsets.sort((x, y) => x - y);
    report.kickOffsetMs = offsets.length
      ? { beats: offsets.length, median: +offsets[offsets.length >> 1].toFixed(2), min: +offsets[0].toFixed(2), max: +offsets[offsets.length - 1].toFixed(2) }
      : 'no beats with kicks on both decks';

    // Low end per side of the bass swap (dB, after EQ and faders).
    const lowDb = (c: number, fromBar: number, toBar: number) => {
      const t0 = runner.outgoingBeatTime((plan.outgoingStartBar + fromBar) * 4)!;
      const t1 = runner.outgoingBeatTime((plan.outgoingStartBar + toBar) * 4)!;
      const low = filtfilt(slice(c, t0, t1), BUTTERWORTH4_Q.map((q) => lowpass(150, SAMPLE_RATE, q)));
      return +(10 * Math.log10(low.reduce((s, v) => s + v * v, 0) / low.length + 1e-12)).toFixed(1);
    };
    const swap = plan.bassSwapBar;
    report.lowEndDb = {
      beforeSwap: { outgoing: lowDb(5, 0, swap - 1), incoming: lowDb(4, 0, swap - 1) },
      afterSwap: { outgoing: lowDb(5, swap + 1, plan.overlapBars), incoming: lowDb(4, swap + 1, plan.overlapBars) },
    };
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
