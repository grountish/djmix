import * as webAudio from 'node-web-audio-api';
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeAudio } from '../analysis/analyzeAudio';
import { synthesizeTrack, type SyntheticSection } from '../analysis/syntheticTrack';
import type { AudioAnalysis } from '../analysis/types';
import { createOfflineMix } from '../engine/offlineMix';
import { createStretchNode } from '../engine/stretch';
import { planTransition } from './planner';
import { renderWithRunner, TransitionRunner } from './runner';
import { trackClock } from './trackClock';

const SAMPLE_RATE = 44100;
const FULL = { kick: true, clap: true, hats: true, bass: true, chords: true };
const A_MINOR = { tonic: 9, mode: 'minor', camelot: '8A', confidence: 1, source: 'tag' } as const;
const OUT = '/private/tmp/claude-501/-Users-mcmilton-Documents-code-djmix/a131b68b-3cda-4573-810f-a63d1dd964d8/scratchpad/levels.txt';

beforeAll(() => {
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= webAudio.AudioWorkletNode;
});

function track(bpm: number, sections: SyntheticSection[]): { channels: Float32Array[]; analysis: AudioAnalysis } {
  const synth = synthesizeTrack({ bpm, firstDownbeat: 0.25, sections });
  const channels = synth.channels.map((c) => c.map((v) => v * 0.5));
  return { channels, analysis: { ...analyzeAudio(channels, SAMPLE_RATE), key: A_MINOR } };
}

describe('level probe', () => {
  it('logs post-fader levels through a blend', async () => {
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
    const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 4, length: seconds * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
    const mix = createOfflineMix(ctx, ctx.createGain(), createStretchNode);
    const taps = ctx.createChannelMerger(4);
    mix.graph.decks.B.fader.connect(taps, 0, 0); // incoming post-fader
    mix.graph.decks.A.fader.connect(taps, 0, 1); // outgoing post-fader
    mix.graph.decks.A.input.connect(taps, 0, 2); // outgoing pre-eq
    mix.graph.master.connect(taps, 0, 3); // master sum
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
    const runner = new TransitionRunner(
      ctx, mix.graph,
      { id: 'A', player: mix.decks.A, clock: trackClock(outgoing.analysis) },
      { id: 'B', player: mix.decks.B, clock: trackClock(incoming.analysis) },
      plan,
    );
    runner.start();
    const out = await renderWithRunner(ctx, runner, [mix.decks.A, mix.decks.B]);
    expect(runner.finished).toBe(true);

    const rms = (ch: number, t0: number, t1: number) => {
      const d = out.getChannelData(ch);
      const a = Math.round(t0 * SAMPLE_RATE), b = Math.min(d.length, Math.round(t1 * SAMPLE_RATE));
      let s = 0; for (let i = a; i < b; i++) s += d[i] * d[i];
      return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12);
    };
    const startBeat = plan.outgoingStartBar * 4;
    const endBeat = startBeat + plan.overlapBars * 4;
    const lines = [`plan ${JSON.stringify({ ...plan, lanes: undefined })}`,
      `incomingStart ${runner.incomingStart.toFixed(3)} overlapEnd ${runner.overlapEnd.toFixed(3)} finish ${runner.finishTime.toFixed(3)}`,
      'beat\tbar\tt\tout_post\tout_pre\tin_post\tmaster\tfader\tlow\tmid\thigh\tfilter'];
    let prev = -Infinity; const jumps: string[] = [];
    const period = (runner.overlapEnd - runner.incomingStart) / (plan.overlapBars * 4);
    for (let beat = startBeat - 24; beat <= endBeat + 12; beat++) {
      const t0 = runner.outgoingBeatTime(beat) ?? runner.overlapEnd + (beat - endBeat) * period;
      const t1 = runner.outgoingBeatTime(beat + 1) ?? t0 + period;
      if (t1 > seconds) break;
      const lanes = runner.laneValues(t0 + 1e-3);
      const o = rms(1, t0, t1);
      const bar = (beat - startBeat) / 4;
      lines.push([beat, bar.toFixed(2), t0.toFixed(2), o.toFixed(1), rms(2, t0, t1).toFixed(1), rms(0, t0, t1).toFixed(1), rms(3, t0, t1).toFixed(1),
        lanes.outgoing.fader?.toFixed(3), lanes.outgoing.low?.toFixed(1), lanes.outgoing.mid?.toFixed(1), lanes.outgoing.high?.toFixed(1), lanes.outgoing.filter?.toFixed(2)].join('\t'));
      if (beat > startBeat && o - prev > 1.5 && o > -45) jumps.push(`beat=${beat} bar=${bar.toFixed(2)} t=${t0.toFixed(2)} ${prev.toFixed(1)} -> ${o.toFixed(1)} dB`);
      prev = o;
    }
    lines.push('JUMPS (outgoing post-fader, >1.5 dB beat to beat):', ...(jumps.length ? jumps : ['none']));
    writeFileSync(OUT, lines.join('\n'));
  }, 180000);
});
