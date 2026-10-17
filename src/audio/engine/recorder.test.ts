import * as webAudio from 'node-web-audio-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { MasterRecorder } from './recorder';
import { encodeWav } from './wav';

const SAMPLE_RATE = 44100;

beforeAll(() => {
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= webAudio.AudioWorkletNode;
});

describe('MasterRecorder', () => {
  it('keeps the last seconds of its input and dumps them in order', async () => {
    const seconds = 6;
    const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 2, length: seconds * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
    // A ramp from 0 to 1 over the render, so a sample's value tells its time.
    const buffer = ctx.createBuffer(2, seconds * SAMPLE_RATE, SAMPLE_RATE);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] = (c === 0 ? 1 : -1) * (i / data.length);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain);
    source.start(0);

    const recorder = await MasterRecorder.attach(ctx, gain, 2);
    let dump: Awaited<ReturnType<MasterRecorder['dump']>> | null = null;
    ctx.suspend(5).then(async () => {
      dump = await recorder.dump(1.5);
      await ctx.resume();
    });
    await ctx.startRendering();

    expect(dump).not.toBeNull();
    const { channels, sampleRate, endTime } = dump!;
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect(channels).toHaveLength(2);
    expect(channels[0].length).toBe(Math.round(1.5 * SAMPLE_RATE));
    expect(endTime).toBeCloseTo(5, 1);
    // The dump ends where the render was and runs forward from 1.5 s before it.
    const last = channels[0][channels[0].length - 1];
    const first = channels[0][0];
    expect(last).toBeCloseTo(endTime / seconds, 2);
    expect(first).toBeCloseTo((endTime - 1.5) / seconds, 2);
    for (let i = 1; i < channels[0].length; i++) expect(channels[0][i]).toBeGreaterThanOrEqual(channels[0][i - 1]);
    expect(channels[1][channels[1].length - 1]).toBeCloseTo(-last, 6);
  });
});

describe('encodeWav', () => {
  it('writes a 16-bit PCM header and interleaved samples', () => {
    const bytes = encodeWav([Float32Array.from([0, 0.5, -1]), Float32Array.from([1, 0, 0.25])], 48000);
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(3 * 2 * 2);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(Math.round(0.5 * 32767));
    expect(view.getInt16(52, true)).toBe(-32767);
  });
});
