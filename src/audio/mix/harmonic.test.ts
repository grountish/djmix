import { describe, expect, it } from 'vitest';
import { fromCamelot } from '../analysis/key';
import { bestKeyShift, harmonicScore, rateShiftSemitones } from './harmonic';

const key = (code: string) => fromCamelot(code)!;

describe('harmonicScore', () => {
  it('rates the Camelot neighbourhood', () => {
    expect(harmonicScore(key('8A'), key('8A'))).toBe(1);
    expect(harmonicScore(key('8A'), key('9A'))).toBe(0.9);
    expect(harmonicScore(key('8A'), key('7A'))).toBe(0.9);
    expect(harmonicScore(key('8A'), key('8B'))).toBe(0.9);
    expect(harmonicScore(key('8A'), key('10A'))).toBe(0.6);
    expect(harmonicScore(key('8A'), key('3A'))).toBe(0.5); // +7: a semitone up
    expect(harmonicScore(key('8A'), key('2A'))).toBe(0);
    expect(harmonicScore(key('8A'), key('9B'))).toBe(0);
  });
});

describe('bestKeyShift', () => {
  it('keeps compatible keys as they are', () => {
    expect(bestKeyShift(key('8A'), key('9A'))).toEqual({ semitones: 0, score: 0.9 });
  });

  it('shifts a clashing key by a semitone when that makes it fit', () => {
    // 3A is a semitone above 8A; dropping it a semitone lands on 8A.
    expect(bestKeyShift(key('8A'), key('3A'))).toEqual({ semitones: -1, score: 1 });
  });
});

describe('rateShiftSemitones', () => {
  it('turns a 6% speed-up into about one semitone', () => {
    expect(rateShiftSemitones(Math.pow(2, 1 / 12))).toBeCloseTo(1, 9);
    expect(rateShiftSemitones(1.06)).toBeCloseTo(1.009, 3);
  });
});
