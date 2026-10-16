import { describe, expect, it } from 'vitest';
import {
  ctxTimeAt,
  nextBarOnClock,
  nextBarTime,
  rebaseAnchor,
  trackTimeAt,
  type PlayheadAnchor,
} from './transport';

describe('playhead anchor', () => {
  const anchor: PlayheadAnchor = { ctxTime: 10, trackTime: 30, rate: 0.96 };

  it('waits at the start offset until a scheduled start', () => {
    expect(trackTimeAt(anchor, 5)).toBe(30);
    expect(trackTimeAt(anchor, 10)).toBe(30);
  });

  it('advances at the playback rate and maps back to the clock', () => {
    expect(trackTimeAt(anchor, 12)).toBeCloseTo(31.92, 12);
    expect(ctxTimeAt(anchor, 31.92)).toBeCloseTo(12, 12);
  });

  it('stays continuous when the rate changes mid-play', () => {
    const rebased = rebaseAnchor(anchor, 15, 1.04);
    expect(trackTimeAt(rebased, 15)).toBeCloseTo(trackTimeAt(anchor, 15), 12);
    expect(trackTimeAt(rebased, 17)).toBeCloseTo(trackTimeAt(anchor, 15) + 2 * 1.04, 12);
  });

  it('keeps a pending start when the rate changes before it', () => {
    expect(rebaseAnchor(anchor, 5, 1.1)).toEqual({ ctxTime: 10, trackTime: 30, rate: 1.1 });
  });
});

describe('bar scheduling', () => {
  const grid = { bpm: 120, firstBeatTime: 0.25 }; // 2 s bars

  it('finds the first bar line strictly after a position', () => {
    expect(nextBarTime(grid, 0)).toBeCloseTo(0.25, 12);
    expect(nextBarTime(grid, 0.25)).toBeCloseTo(2.25, 12);
    expect(nextBarTime(grid, 1)).toBeCloseTo(2.25, 12);
    expect(nextBarTime(grid, 9.9)).toBeCloseTo(10.25, 12);
  });

  it('skips a bar line that is closer than the minimum lead', () => {
    const anchor: PlayheadAnchor = { ctxTime: 10, trackTime: 0, rate: 1 };
    // Track is at 2.2 s; the 2.25 s bar line is only 50 ms away.
    expect(nextBarOnClock(anchor, grid, 12.2, 0.1)).toEqual({ trackTime: 4.25, ctxTime: 14.25 });
    expect(nextBarOnClock(anchor, grid, 12.1, 0.1)).toEqual({ trackTime: 2.25, ctxTime: 12.25 });
  });

  it('maps the bar line through the deck rate', () => {
    const anchor: PlayheadAnchor = { ctxTime: 10, trackTime: 0, rate: 0.96 };
    const start = nextBarOnClock(anchor, grid, 10, 0.1);
    expect(start.trackTime).toBeCloseTo(0.25, 12);
    expect(start.ctxTime).toBeCloseTo(10 + 0.25 / 0.96, 12);
  });
});
