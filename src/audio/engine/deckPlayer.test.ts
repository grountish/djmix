import * as webAudio from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { DeckPlayer } from './deckPlayer';

const SAMPLE_RATE = 48000;

/** A buffer whose sample value is its position in seconds, so the output says where the playhead was. */
function rampBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, seconds * SAMPLE_RATE, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = i / SAMPLE_RATE;
  return buffer;
}

describe('DeckPlayer.scheduleJump', () => {
  it('moves the playhead at the scheduled instant and keeps the math right until then', async () => {
    const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 1, length: 2 * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
    const deck = new DeckPlayer(ctx, ctx.destination);
    await deck.load(rampBuffer(ctx, 4));
    deck.play(0);
    const at = deck.scheduleJump(1, 0.25);
    expect(at).toBeCloseTo(1, 6);
    // Before the jump the playhead still reads from the first anchor.
    expect(deck.currentTime()).toBeCloseTo(0, 6);

    // Mid-render the playhead reads from the jump anchor.
    let midway = { time: NaN, playing: false };
    ctx.suspend(1.5).then(() => {
      midway = { time: deck.currentTime(), playing: deck.isPlaying };
      ctx.resume();
    });
    const out = (await ctx.startRendering()).getChannelData(0);
    const sampleAt = (t: number) => out[Math.round(t * SAMPLE_RATE)];
    expect(sampleAt(0.5)).toBeCloseTo(0.5, 3);
    expect(sampleAt(0.999)).toBeCloseTo(0.999, 3);
    // From 1 s on the track plays from 0.25 s.
    expect(sampleAt(1.001)).toBeCloseTo(0.251, 3);
    expect(sampleAt(1.5)).toBeCloseTo(0.75, 3);
    expect(midway.playing).toBe(true);
    expect(midway.time).toBeCloseTo(0.75, 2);
  });

  it('takes a new rate along with the jump', async () => {
    const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 1, length: 2 * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
    const deck = new DeckPlayer(ctx, ctx.destination);
    await deck.load(rampBuffer(ctx, 4));
    deck.play(0);
    deck.scheduleJump(1, 1, 2);
    const out = (await ctx.startRendering()).getChannelData(0);
    // 0.5 s after the jump at double speed: one second into the track past the jump target.
    expect(out[Math.round(1.5 * SAMPLE_RATE)]).toBeCloseTo(2, 2);
    expect(deck.currentRate).toBe(2);
  });

  it('only moves the paused position when the deck is stopped', async () => {
    const ctx = new webAudio.OfflineAudioContext({ numberOfChannels: 1, length: SAMPLE_RATE, sampleRate: SAMPLE_RATE });
    const deck = new DeckPlayer(ctx, ctx.destination);
    await deck.load(rampBuffer(ctx, 4));
    deck.scheduleJump(0.5, 1.5);
    expect(deck.isPlaying).toBe(false);
    expect(deck.currentTime()).toBe(1.5);
  });
});
