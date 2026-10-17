import { describe, expect, it } from 'vitest';
import { crossfaderGains } from './curves';
import { crossfaderGainsFor } from './crossfaderCurve';

describe('crossfader curves', () => {
  it('smooth is the existing blend law', () => {
    for (const x of [-1, -0.5, 0, 0.3, 1]) {
      expect(crossfaderGainsFor({ curve: 'smooth', reverse: false }, x)).toEqual(crossfaderGains(x));
    }
  });

  it('sharp keeps the far deck at full level until the last stretch of travel', () => {
    const sharp = { curve: 'sharp' as const, reverse: false };
    expect(crossfaderGainsFor(sharp, 0)).toEqual({ a: 1, b: 1 });
    expect(crossfaderGainsFor(sharp, 0.9)).toEqual({ a: 1, b: 1 });
    expect(crossfaderGainsFor(sharp, -0.9)).toEqual({ a: 1, b: 1 });
    const nearEnd = crossfaderGainsFor(sharp, 0.96);
    expect(nearEnd.a).toBeGreaterThan(0);
    expect(nearEnd.a).toBeLessThan(1);
    expect(nearEnd.b).toBe(1);
    expect(crossfaderGainsFor(sharp, 1).a).toBeCloseTo(0, 9);
    expect(crossfaderGainsFor(sharp, -1).b).toBeCloseTo(0, 9);
  });

  it('linear fades straight from the centre', () => {
    const linear = { curve: 'linear' as const, reverse: false };
    expect(crossfaderGainsFor(linear, 0)).toEqual({ a: 1, b: 1 });
    expect(crossfaderGainsFor(linear, 0.5)).toEqual({ a: 0.5, b: 1 });
    expect(crossfaderGainsFor(linear, -0.25)).toEqual({ a: 1, b: 0.75 });
    expect(crossfaderGainsFor(linear, 1)).toEqual({ a: 0, b: 1 });
  });

  it('reverse swaps the sides', () => {
    for (const curve of ['smooth', 'sharp', 'linear'] as const) {
      const normal = crossfaderGainsFor({ curve, reverse: false }, 0.7);
      const reversed = crossfaderGainsFor({ curve, reverse: true }, -0.7);
      expect(reversed).toEqual(normal);
    }
  });

  it('clamps positions beyond the ends', () => {
    expect(crossfaderGainsFor({ curve: 'linear', reverse: false }, 3)).toEqual({ a: 0, b: 1 });
  });
});
