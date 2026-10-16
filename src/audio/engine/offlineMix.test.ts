import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { createOfflineMix, type OfflineMix } from './offlineMix';
import { scheduleCrossfade, setCrossfaderPosition, setParamSmooth } from './mixGraph';
import { type BeatGrid, ctxTimeAt, nextBarOnClock } from './transport';

const SAMPLE_RATE = 44100;

/**
 * Offline mix whose output channels are deck A and deck B. Timing taps sit before the EQ
 * (whose crossovers delay lows by a few ms); level taps sit after the crossfader.
 */
function createTappedMix(seconds: number, tap: 'timing' | 'level' = 'level'): OfflineMix {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  const mix = createOfflineMix(ctx, ctx.createGain());
  const taps = ctx.createChannelMerger(2);
  const point = tap === 'timing' ? 'input' : 'crossfade';
  mix.graph.decks.A[point].connect(taps, 0, 0);
  mix.graph.decks.B[point].connect(taps, 0, 1);
  taps.connect(ctx.destination);
  return mix;
}

/** One-sample click on every beat of the grid. */
function clickTrack(ctx: BaseAudioContext, grid: BeatGrid, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.round(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  for (let t = grid.firstBeatTime; t < seconds; t += 60 / grid.bpm) {
    data[Math.round(t * SAMPLE_RATE)] = 1;
  }
  return buffer;
}

function constant(ctx: BaseAudioContext, value: number, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.round(seconds * SAMPLE_RATE), SAMPLE_RATE);
  buffer.getChannelData(0).fill(value);
  return buffer;
}

function findClicks(data: Float32Array, threshold = 0.25): number[] {
  const clicks: number[] = [];
  for (let i = 1; i < data.length - 1; i++) {
    if (data[i] > threshold && data[i] >= data[i - 1] && data[i] > data[i + 1]) {
      clicks.push(i);
    }
  }
  return clicks;
}

function sampleAt(data: Float32Array, seconds: number): number {
  return data[Math.round(seconds * SAMPLE_RATE)];
}

describe('offline mix engine', () => {
  it('starts the incoming deck exactly on the outgoing bar line, tempo-synced', async () => {
    const mix = createTappedMix(8, 'timing');
    const gridA: BeatGrid = { bpm: 120, firstBeatTime: 0.25 };
    const gridB: BeatGrid = { bpm: 125, firstBeatTime: 0.1 };
    await mix.decks.A.load(clickTrack(mix.ctx, gridA, 10));
    await mix.decks.B.load(clickTrack(mix.ctx, gridB, 10));
    mix.decks.A.play(0);

    let scheduledAt = 0;
    mix.ctx.suspend(1.3).then(() => {
      const start = nextBarOnClock(mix.decks.A.getAnchor()!, gridA, mix.ctx.currentTime, 0.1);
      mix.decks.B.setRate(gridA.bpm / gridB.bpm);
      mix.decks.B.seek(gridB.firstBeatTime);
      mix.decks.B.play(start.ctxTime);
      scheduledAt = start.ctxTime;
      mix.ctx.resume();
    });

    const out = await mix.ctx.startRendering();
    const clicksA = findClicks(out.getChannelData(0));
    const clicksB = findClicks(out.getChannelData(1));

    expect(scheduledAt).toBeCloseTo(2.25, 9);
    expect(clicksB.length).toBeGreaterThanOrEqual(10);
    expect(Math.abs(clicksB[0] - 2.25 * SAMPLE_RATE)).toBeLessThanOrEqual(1);
    for (const click of clicksB) {
      const nearestA = Math.min(...clicksA.map((a) => Math.abs(a - click)));
      expect(nearestA).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the reported playhead on the audio after a rate change mid-play', async () => {
    const mix = createTappedMix(4, 'timing');
    const grid: BeatGrid = { bpm: 120, firstBeatTime: 0.1 };
    await mix.decks.A.load(clickTrack(mix.ctx, grid, 10));
    mix.decks.A.play(0);

    let anchor = mix.decks.A.getAnchor()!;
    mix.ctx.suspend(1).then(() => {
      mix.decks.A.setRate(0.5);
      anchor = mix.decks.A.getAnchor()!;
      mix.ctx.resume();
    });

    const out = await mix.ctx.startRendering();
    const clicks = findClicks(out.getChannelData(0));

    const expected: number[] = [];
    for (let beat = grid.firstBeatTime; ; beat += 60 / grid.bpm) {
      const at = beat < anchor.trackTime ? beat : ctxTimeAt(anchor, beat);
      if (at >= 3.99) break;
      expected.push(at * SAMPLE_RATE);
    }

    expect(anchor.rate).toBe(0.5);
    expect(clicks).toHaveLength(expected.length);
    clicks.forEach((click, i) => expect(Math.abs(click - expected[i])).toBeLessThanOrEqual(1));
  });

  it('keeps the channel fader level through seek, pause and play', async () => {
    const mix = createTappedMix(3);
    await mix.decks.A.load(constant(mix.ctx, 1, 10));
    setParamSmooth(mix.graph.decks.A.fader.gain, 0.5, mix.ctx);
    mix.decks.A.play(0);

    let positionAfterSeek = 0;
    mix.ctx.suspend(1).then(() => {
      mix.decks.A.seek(5);
      positionAfterSeek = mix.decks.A.currentTime();
      mix.ctx.resume();
    });
    mix.ctx.suspend(2).then(() => {
      mix.decks.A.pause();
      mix.decks.A.play();
      mix.ctx.resume();
    });

    const out = await mix.ctx.startRendering();
    const deckA = out.getChannelData(0);
    const expectedLevel = 0.5; // fader × centred crossfader (unity)
    const levelHolds = (from: number, to: number) => {
      for (let i = Math.round(from * SAMPLE_RATE); i < Math.round(to * SAMPLE_RATE); i++) {
        if (Math.abs(deckA[i] - expectedLevel) >= 1e-3) return false;
      }
      return true;
    };

    expect(positionAfterSeek).toBeCloseTo(5, 9);
    // Seeking while playing hands over without a gap.
    expect(levelHolds(0.2, 2)).toBe(true);
    // Pause then play resumes at the same level instead of resetting to unity.
    expect(levelHolds(2.1, 3)).toBe(true);
  });

  it('runs a crossfader sweep on the audio clock', async () => {
    const mix = createTappedMix(3);
    await mix.decks.A.load(constant(mix.ctx, 1, 10));
    await mix.decks.B.load(constant(mix.ctx, 1, 10));
    setCrossfaderPosition(mix.graph, -1);
    mix.decks.A.play(0);
    mix.decks.B.play(0);

    mix.ctx.suspend(0.5).then(() => {
      scheduleCrossfade(mix.graph, -1, 1, 1, 1);
      mix.ctx.resume();
    });

    const out = await mix.ctx.startRendering();
    const deckA = out.getChannelData(0);
    const deckB = out.getChannelData(1);

    expect(sampleAt(deckA, 0.75)).toBeCloseTo(1, 3);
    expect(sampleAt(deckB, 0.75)).toBeCloseTo(0, 3);
    expect(sampleAt(deckB, 1.25)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(sampleAt(deckA, 1.5)).toBeCloseTo(1, 2);
    expect(sampleAt(deckB, 1.5)).toBeCloseTo(1, 2);
    expect(sampleAt(deckA, 1.75)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(sampleAt(deckA, 2.5)).toBeCloseTo(0, 3);
    expect(sampleAt(deckB, 2.5)).toBeCloseTo(1, 3);
    // The louder deck never dips during the sweep.
    for (let t = 1; t <= 2; t += 0.01) {
      expect(Math.max(sampleAt(deckA, t), sampleAt(deckB, t))).toBeGreaterThan(0.99);
    }
  });
});
