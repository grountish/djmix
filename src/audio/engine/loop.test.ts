import * as webAudio from 'node-web-audio-api';
import { describe, expect, it, vi } from 'vitest';
import { constantClock } from '../analysis/beatClock';
import { DeckPlayer } from './deckPlayer';
import { LoopController } from './loop';

const SAMPLE_RATE = 48000;
// 120 BPM, first beat at 0: beat n at n/2 s.
const clock = constantClock(0, 0.5);

/** A buffer whose sample value is its position in seconds, so the output says where the playhead was. */
function rampBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, seconds * SAMPLE_RATE, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = i / SAMPLE_RATE;
  return buffer;
}

async function setup(seconds: number) {
  const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 1, length: seconds * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
  const deck = new DeckPlayer(ctx, ctx.destination);
  await deck.load(rampBuffer(ctx, 8));
  const loop = new LoopController(deck, ctx);
  loop.setClock(clock);
  /** Runs `action` when the render reaches `time`. */
  const at = (time: number, action: () => void) =>
    ctx.suspend(time).then(() => {
      action();
      ctx.resume();
    });
  const render = async () => {
    const out = (await ctx.startRendering()).getChannelData(0);
    return (t: number) => out[Math.round(t * SAMPLE_RATE)];
  };
  return { ctx, deck, loop, at, render };
}

describe('LoopController', () => {
  it('auto-loops on the nearest beat and wraps exactly on the audio clock', async () => {
    const { deck, loop, at, render } = await setup(4);
    const jumps = vi.spyOn(deck, 'scheduleJump');
    deck.play(0);
    // 2 beats from 1.1 s: the nearest beat is 1.0 s, so the loop is [1, 2).
    expect(loop.autoLoop(2, 1.1)).toEqual({ start: 1, end: 2 });
    expect(loop.lengthBeats).toBe(2);
    expect(loop.isActive).toBe(true);

    at(1.5, () => loop.tick()); // Half a second out: beyond the horizon, nothing armed.
    at(1.6, () => expect(jumps).not.toHaveBeenCalled());
    at(1.8, () => loop.tick());
    at(1.9, () => loop.tick()); // Already armed: nothing more.
    at(2.1, () => expect(jumps).toHaveBeenCalledTimes(1));
    at(2.8, () => loop.tick());
    const sample = await render();
    expect(sample(1.5)).toBeCloseTo(1.5, 3);
    expect(sample(1.999)).toBeCloseTo(1.999, 3);
    expect(sample(2.001)).toBeCloseTo(1.001, 3);
    expect(sample(2.5)).toBeCloseTo(1.5, 3);
    expect(sample(3.001)).toBeCloseTo(1.001, 3);
    expect(sample(3.5)).toBeCloseTo(1.5, 3);
    expect(jumps).toHaveBeenCalledTimes(2);
  });

  it('leaves a playhead outside the region alone', async () => {
    const { deck, loop, at, render } = await setup(3);
    deck.play(0);
    loop.autoLoop(2, 1);
    at(0.5, () => deck.seek(2.5)); // Past the loop end.
    at(2.0, () => loop.tick());
    at(2.6, () => loop.tick());
    const sample = await render();
    // The seek lands a scheduling lead after 0.5 s; from there the track runs straight on.
    expect(sample(2.9)).toBeGreaterThan(4.8);
    expect(sample(2.9)).toBeLessThan(4.9);
    expect(loop.isActive).toBe(true);
  });

  it('exit redirects an armed wrap so the track plays straight through', async () => {
    const { deck, loop, at, render } = await setup(3);
    deck.play(0);
    loop.autoLoop(2, 1);
    at(1.8, () => loop.tick());
    at(1.9, () => loop.exit());
    const sample = await render();
    expect(loop.isActive).toBe(false);
    expect(loop.currentRegion).toEqual({ start: 1, end: 2 });
    expect(sample(2.1)).toBeCloseTo(2.1, 3);
    expect(sample(2.5)).toBeCloseTo(2.5, 3);
  });

  it('halving past the new end jumps back in step; doubling keeps the start', async () => {
    const { deck, loop, at, render } = await setup(4);
    deck.play(0);
    loop.autoLoop(4, 1); // [1, 3)
    at(2.6, () => loop.halve()); // [1, 2): the playhead at 2.6 is 0.6 into the second pass.
    at(2.9, () => loop.tick());
    const sample = await render();
    expect(loop.currentRegion).toEqual({ start: 1, end: 2 });
    expect(sample(2.9)).toBeCloseTo(1.9, 2);
    expect(sample(3.2)).toBeCloseTo(1.2, 2);
    loop.double();
    expect(loop.currentRegion).toEqual({ start: 1, end: 3 });
    loop.double();
    loop.double();
    loop.double();
    expect(loop.currentRegion!.end).toBeLessThanOrEqual(8);
  });

  it('loop in / out snap to beats and reloop returns to the region', async () => {
    const { deck, loop } = await setup(1);
    expect(loop.loopIn(1.1)).toBe(1);
    expect(loop.loopOut(1.05)).toBeNull(); // Empty loop.
    expect(loop.loopOut(2.2)).toEqual({ start: 1, end: 2 });
    expect(loop.loopIn(1.3, false)).toBe(1.3);
    expect(loop.loopOut(2.6, false)).toEqual({ start: 1.3, end: 2.6 });
    loop.exit();
    deck.seek(5);
    loop.reloop();
    expect(loop.isActive).toBe(true);
    expect(deck.currentTime()).toBe(1.3);
    loop.setClock(null); // A grid change keeps the loop: it is in seconds.
    expect(loop.currentRegion).toEqual({ start: 1.3, end: 2.6 });
    loop.clear();
    expect(loop.currentRegion).toBeNull();
    expect(loop.isActive).toBe(false);
  });
});
