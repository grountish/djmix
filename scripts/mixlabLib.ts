/**
 * Shared by the mixlab (one pair) and mixset (a whole set) CLIs: decode and analyse tracks,
 * render a transition offline through the real mix graph, and measure it.
 */
import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { parseFile } from 'music-metadata';
import * as webAudio from 'node-web-audio-api';
import { analyzeAudio } from '../src/audio/analysis/analyzeAudio';
import { keyFromTag } from '../src/audio/analysis/key';
import type { AudioAnalysis } from '../src/audio/analysis/types';
import { describePlan } from '../src/audio/automixController';
import { loudnessTrimDb } from '../src/audio/engine/curves';
import { attachLimiter } from '../src/audio/engine/limiter';
import { createOfflineMix } from '../src/audio/engine/offlineMix';
import { createStretchNode } from '../src/audio/engine/stretch';
import { encodeWav } from '../src/audio/engine/wav';
import { summarizeTransition, type TransitionChecks, type TransitionMetrics } from '../src/audio/mix/metrics';
import { planTransition, type PlanPolicy, type TransitionPlan } from '../src/audio/mix/planner';
import { renderWithRunner, TransitionRunner } from '../src/audio/mix/runner';
import { trackClock } from '../src/audio/mix/trackClock';

(globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= webAudio.AudioWorkletNode;

export const SAMPLE_RATE = 44100;
/** Bars of the outgoing track played before its tempo ramp starts. */
const RUN_IN_BARS = 8;
const TAIL_SECONDS = 8;

export interface LoadedTrack {
  file: string;
  name: string;
  buffer: AudioBuffer;
  analysis: AudioAnalysis;
}

export async function decodeFile(file: string): Promise<AudioBuffer> {
  const data = readFileSync(file);
  const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: SAMPLE_RATE });
  return ctx.decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

/**
 * Decodes and analyses a file as the app does: the tagged tempo settles the octave, a key tag
 * is preferred over detection.
 */
export async function loadTrack(file: string, analysis?: AudioAnalysis): Promise<LoadedTrack> {
  const buffer = await decodeFile(file);
  let result = analysis;
  if (!result) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const tags = (await parseFile(file, { skipCovers: true })).common;
    result = analyzeAudio(channels, buffer.sampleRate, { bpm: tags.bpm });
    const tagged = keyFromTag(tags.key as string | undefined);
    if (tagged) result = { ...result, key: tagged };
  }
  return { file, name: basename(file), buffer, analysis: result };
}

export interface RenderOptions {
  policy?: Partial<PlanPolicy>;
  /** Writes the rendered master here. */
  wavPath?: string;
}

/** The numbers a pair's render is judged by (what mixlab prints and mixset tabulates). */
export interface PairReport {
  outgoing: string;
  incoming: string;
  plan: string;
  kind: TransitionPlan['kind'];
  overlapBars: number;
  meetBpm: number;
  warnings: string[];
  /** The beat clocks disagreed and the incoming deck wasn't beat-locked. */
  lockAbandoned: boolean;
  seconds: number;
  masterPeakDb: number;
  beatAlignmentMs?: { beats: number; mean: number; median: number; p95: number; max: number };
  kickPhase?: { offsetMs: number; correlation: number; coherence: { a: number; b: number }; onsets: { a: number; b: number } };
  lowBandCollisions?: number[];
  loudnessDeviationLu?: number;
  balance?: { templateExcessDb: number; balancedExcessDb: number };
  forecast?: { rmsErrorDb: number; maxAbsErrorDb: number; measuredExcessDb: number; measuredHoleDb: number };
  checks?: TransitionChecks;
  pass?: boolean;
}

export interface RenderResult {
  plan: TransitionPlan;
  report: PairReport;
  metrics?: TransitionMetrics;
  /** Clock times of the overlap and the incoming deck's start, for debugging. */
  times: { incomingStart: number; overlapEnd: number };
}

/**
 * Renders `outgoing → incoming` the way Auto would play it: the plan is made from the start
 * of the outgoing track to find the mix-out point, the render begins a few bars before the
 * tempo ramp, and the same graph, trims, key lock and runner as the app are used.
 */
export async function renderTransition(outgoing: LoadedTrack, incoming: LoadedTrack, options: RenderOptions = {}): Promise<RenderResult> {
  const clockOut = trackClock(outgoing.analysis);
  const policy = options.policy;
  const draft = planTransition({
    outgoing: { analysis: outgoing.analysis, trackTime: 0, rate: 1, semitones: 0 },
    incoming: { analysis: incoming.analysis },
    policy,
  });
  const startTrackTime = Math.max(0, clockOut.timeOf((draft.outgoingRampStartBar - RUN_IN_BARS) * 4));
  const plan = planTransition({
    outgoing: { analysis: outgoing.analysis, trackTime: startTrackTime, rate: 1, semitones: 0 },
    incoming: { analysis: incoming.analysis },
    policy,
  });

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
  for (const [id, track] of [['A', outgoing], ['B', incoming]] as const) {
    mix.graph.decks[id].input.gain.value = Math.pow(10, loudnessTrimDb(track.analysis.loudness.integratedLufs) / 20);
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
  if (options.wavPath) writeFileSync(options.wavPath, encodeWav([channel(0), channel(1)], SAMPLE_RATE));

  let peak = 0;
  for (const c of [0, 1]) for (const v of channel(c)) peak = Math.max(peak, Math.abs(v));
  const report: PairReport = {
    outgoing: outgoing.name,
    incoming: incoming.name,
    plan: describePlan(plan),
    kind: plan.kind,
    overlapBars: plan.overlapBars,
    meetBpm: +plan.tempo.meetBpm.toFixed(2),
    warnings: plan.warnings,
    lockAbandoned: runner.lockAbandoned,
    seconds,
    masterPeakDb: +(20 * Math.log10(peak)).toFixed(2),
  };
  const times = { incomingStart: runner.incomingStart, overlapEnd: runner.overlapEnd };
  if (plan.overlapBars === 0) return { plan, report, times };

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
    periodSeconds: 60 / plan.tempo.meetBpm,
    barTimes: Array.from({ length: plan.overlapBars + 1 }, (_, b) => runner.outgoingBeatTime(startBeat + 4 * b)!),
    forecast: plan.balance,
  });
  const round = (v: number, digits = 2) => (Number.isFinite(v) ? +v.toFixed(digits) : v);
  report.beatAlignmentMs = {
    beats: metrics.alignment.summary.count,
    mean: round(metrics.alignment.summary.meanMs),
    median: round(metrics.alignment.summary.medianMs),
    p95: round(metrics.alignment.summary.p95AbsMs),
    max: round(metrics.alignment.summary.maxAbsMs),
  };
  if (metrics.phase) {
    report.kickPhase = {
      offsetMs: round(metrics.phase.offsetMs),
      correlation: round(metrics.phase.correlation),
      coherence: { a: round(metrics.phase.coherence.a), b: round(metrics.phase.coherence.b) },
      onsets: metrics.phase.onsets,
    };
  }
  report.lowBandCollisions = metrics.unexpectedCollisionBeats;
  report.loudnessDeviationLu = round(metrics.loudnessDeviationLu);
  if (plan.balance) {
    report.balance = { templateExcessDb: plan.balance.templateExcessDb, balancedExcessDb: plan.balance.balancedExcessDb };
  }
  if (metrics.forecast) {
    report.forecast = {
      rmsErrorDb: round(metrics.forecast.rmsErrorDb),
      maxAbsErrorDb: round(metrics.forecast.maxAbsErrorDb),
      measuredExcessDb: round(metrics.forecast.measuredExcessDb),
      measuredHoleDb: round(metrics.forecast.measuredHoleDb),
    };
  }
  report.checks = metrics.checks;
  report.pass = metrics.pass;
  return { plan, report, metrics, times };
}

/** The forecast and measured band rows, collision detail and loudness curve, for a close look. */
export function printDebug(result: RenderResult): void {
  const { plan, metrics, times } = result;
  if (!metrics) return;
  const row = (values: number[]) => values.map((v) => (Number.isFinite(v) ? v.toFixed(0).padStart(4) : '   -')).join('');
  console.log('aligned beats', JSON.stringify(metrics.alignment.beats.map((b) => [b.beat, +b.diffMs.toFixed(1)])));
  for (const beat of metrics.unexpectedCollisionBeats) {
    const around = (values: number[]) =>
      values.slice(Math.max(0, beat - 2), beat + 3).map((v) => v.toFixed(1).padStart(6)).join('');
    console.log(
      `collision at beat ${beat} (bar ${(beat / 4).toFixed(2)}): out ${around(metrics.collisions.aDb)} | in ${around(metrics.collisions.bDb)} (dB rel. own loudest, beats ${beat - 2}…${beat + 2})`,
    );
  }
  const { times: lufsTimes, lufs } = metrics.loudness;
  const curve = lufsTimes
    .map((t, i) => [t, lufs[i]] as const)
    .filter(([t]) => t >= times.incomingStart - 8 && t <= times.overlapEnd + 8 && Math.round(t * 10) % 10 === 0)
    .map(([t, l]) => `${(t - times.incomingStart).toFixed(0)}s:${l.toFixed(1)}`);
  console.log('short-term LUFS around the overlap (s from start):', curve.join(' '));
  if (plan.balance) {
    for (const band of ['low', 'mid', 'high'] as const) {
      const { reference, template, balanced } = plan.balance.bands[band];
      console.log(`${band.padEnd(5)} ref ${row(reference)}\n      tpl ${row(template)}\n      bal ${row(balanced)}`);
      if (metrics.bands && metrics.forecast) {
        const calibrated = metrics.bands.sum[band].map((v) => v - metrics.forecast!.calibrationDb[band]);
        console.log(`      msr ${row(calibrated)}  (render, on the forecast's scale)`);
      }
    }
  }
}
