import { describe, expect, it } from 'vitest';
import { constantClock } from '../analysis/beatClock';
import type { Phrase } from '../analysis/types';
import { nearestPhaseDelta, nextUnitOnClock, phaseSyncTarget, phraseStartBar } from './sync';

// 120 BPM, first downbeat at 0: beat n at n/2 s.
const master = { clock: constantClock(0, 0.5), anchor: { ctxTime: 10, trackTime: 0, rate: 1 } };
// 128 BPM analysed, first downbeat at 0.1 s; played at the master's tempo (0.5 s per beat).
const followerClock = constantClock(0.1, 0.5);

function phrase(startBar: number, bars: number): Phrase {
  return { startBar, bars, label: 'build', hasKick: true, hasBass: true, energyDb: -10 };
}

describe('nearestPhaseDelta', () => {
  it('moves the shortest way round', () => {
    expect(nearestPhaseDelta(0.3, 1)).toBeCloseTo(0.3);
    expect(nearestPhaseDelta(0.7, 1)).toBeCloseTo(-0.3);
    expect(nearestPhaseDelta(-0.7, 1)).toBeCloseTo(0.3);
    expect(nearestPhaseDelta(3, 4)).toBeCloseTo(-1);
    expect(nearestPhaseDelta(-3, 4)).toBeCloseTo(1);
    expect(nearestPhaseDelta(2, 4)).toBeCloseTo(2);
    expect(nearestPhaseDelta(8, 4)).toBeCloseTo(0);
  });
});

describe('phaseSyncTarget', () => {
  // At clock 13.3 the master sits on beat 6.6: 0.6 beats into a beat, bar 1 beat 2.6.
  const at = 13.3;

  it('tempo mode leaves the follower alone', () => {
    expect(phaseSyncTarget('tempo', master, { clock: followerClock, trackTime: 4.2 }, at)).toBe(4.2);
  });

  it('beat mode lands on the same beat phase by the shortest move', () => {
    // Follower at 4.2 s = beat 8.2 (phase 0.2); master phase 0.6: move +0.4 beats.
    const target = phaseSyncTarget('beat', master, { clock: followerClock, trackTime: 4.2 }, at);
    expect(followerClock.beatAt(target)).toBeCloseTo(8.6, 9);
    // Follower at beat 8.9 (phase 0.9): the nearest 0.6 is 8.6, backwards.
    const back = phaseSyncTarget('beat', master, { clock: followerClock, trackTime: followerClock.timeOf(8.9) }, at);
    expect(followerClock.beatAt(back)).toBeCloseTo(8.6, 9);
  });

  it('bar mode also matches the beat within the bar', () => {
    // Master is at beat 2.6 of its bar. Follower at beat 8.2 (beat 0.2 of a bar): the nearest
    // beat 2.6 of a bar is 6.6 (-1.6), not 10.6 (+2.4).
    const target = phaseSyncTarget('bar', master, { clock: followerClock, trackTime: 4.2 }, at);
    expect(followerClock.beatAt(target)).toBeCloseTo(6.6, 9);
    // Follower at beat 9.0 (bar beat 1): nearest 2.6 is 10.6 (+1.6) rather than 6.6 (-2.4).
    const forward = phaseSyncTarget('bar', master, { clock: followerClock, trackTime: followerClock.timeOf(9) }, at);
    expect(followerClock.beatAt(forward)).toBeCloseTo(10.6, 9);
  });

  it('phrase mode lines the phrases up on a 16-bar grid by default', () => {
    // Master at bar 1.65 of its phrase 0 (bars 0–16). Follower at bar 33: nearest phrase starts
    // at bar 32, so it should go to bar 33.65 (14.35 bars to go, like the master).
    const target = phaseSyncTarget('phrase', master, { clock: followerClock, trackTime: followerClock.timeOf(33 * 4) }, at);
    expect(followerClock.beatAt(target) / 4).toBeCloseTo(33.65, 9);
  });

  it('phrase mode makes the phrases change together', () => {
    // Master phrases: 0–8 intro, 8–24 build. At bar 10.65 it has 13.35 bars of build to go.
    const m = { ...master, phrases: [phrase(0, 8), phrase(8, 16)] };
    const atBar10 = master.anchor.ctxTime + master.clock.timeOf(10.65 * 4);
    // Follower phrases: 0–16, 16–48. At bar 20 the nearest position with 13.35 bars to go is
    // 48 - 13.35 in the second phrase (the first's would be 2.65, further away).
    const f = { clock: followerClock, trackTime: followerClock.timeOf(20 * 4), phrases: [phrase(0, 16), phrase(16, 32)] };
    const target = phaseSyncTarget('phrase', m, f, atBar10);
    expect(followerClock.beatAt(target) / 4).toBeCloseTo(34.65, 9);
    // A follower near its first phrase takes that one: 16 - 13.35.
    const early = phaseSyncTarget('phrase', m, { ...f, trackTime: followerClock.timeOf(4 * 4) }, atBar10);
    expect(followerClock.beatAt(early) / 4).toBeCloseTo(2.65, 9);
    // Past the follower's last phrase the grid keeps going every 16 bars: bar 58 → 48 + 2.65,
    // bar 60 is nearer to 64 + 2.65.
    const late = phaseSyncTarget('phrase', m, { ...f, trackTime: followerClock.timeOf(58 * 4) }, atBar10);
    expect(followerClock.beatAt(late) / 4).toBeCloseTo(50.65, 9);
    const later = phaseSyncTarget('phrase', m, { ...f, trackTime: followerClock.timeOf(60 * 4) }, atBar10);
    expect(followerClock.beatAt(later) / 4).toBeCloseTo(66.65, 9);
  });
});

describe('phaseSyncTarget at the start of a track', () => {
  it('never lands before the track starts: it takes the next position in phase', () => {
    // Master on beat 6.536 at 13.268: a follower parked at 0 (beat -0.2 of its own grid) would
    // land at beat -0.464 for beat sync; it goes to beat 0.536 instead, and to beat 2.536 for
    // bar sync rather than -1.464.
    const at = 10 + 6.536 * 0.5;
    const parked = { clock: followerClock, trackTime: 0 };
    expect(followerClock.beatAt(phaseSyncTarget('beat', master, parked, at))).toBeCloseTo(0.536, 9);
    expect(followerClock.beatAt(phaseSyncTarget('bar', master, parked, at))).toBeCloseTo(2.536, 9);
    expect(phaseSyncTarget('phrase', master, parked, at)).toBeGreaterThanOrEqual(0);
  });
});

describe('phrase mode with phrases too short for the master', () => {
  it('falls back to the same distance into the nearest phrase', () => {
    // Master in a 32-bar phrase with 20 bars to go (12 in); follower phrases are 8 bars long.
    const m = { ...master, phrases: [phrase(0, 32)] };
    const atBar12 = master.anchor.ctxTime + master.clock.timeOf(12 * 4);
    const f = { clock: followerClock, trackTime: followerClock.timeOf(9 * 4), phrases: [phrase(0, 8), phrase(8, 8)] };
    // The grid cells after the phrases are 16 bars: still too short. Nearest start + 12 to bar 9
    // is 0 + 12 (8 + 12 is further).
    expect(followerClock.beatAt(phaseSyncTarget('phrase', m, f, atBar12)) / 4).toBeCloseTo(12, 9);
  });
});

describe('phraseStartBar', () => {
  it('uses analysed phrases, a 16-bar grid before and after them', () => {
    const phrases = [phrase(4, 8), phrase(12, 16)];
    expect(phraseStartBar(5, phrases)).toBe(4);
    expect(phraseStartBar(12, phrases)).toBe(12);
    expect(phraseStartBar(27.9, phrases)).toBe(12);
    expect(phraseStartBar(28, phrases)).toBe(28);
    expect(phraseStartBar(45, phrases)).toBe(44);
    expect(phraseStartBar(2, phrases)).toBe(0);
    expect(phraseStartBar(37, undefined)).toBe(32);
  });
});

describe('nextUnitOnClock', () => {
  it('finds the next bar line of the master at least the lead ahead', () => {
    // Master beat 6.6 at 13.3; next bar line is beat 8 at clock 14.
    expect(nextUnitOnClock(master, 4, 13.3, 0.1)).toEqual({ ctxTime: 14, trackTime: 4 });
    // Too close: the lead pushes it to the following bar.
    expect(nextUnitOnClock(master, 4, 13.95, 0.1)).toEqual({ ctxTime: 16, trackTime: 6 });
    // Beats: the next beat after 13.3 + 0.1 is beat 7 at 13.5.
    expect(nextUnitOnClock(master, 1, 13.3, 0.1)).toEqual({ ctxTime: 13.5, trackTime: 3.5 });
  });
});
