import { describe, expect, it } from 'vitest';
import { equalPowerGains } from './curves';

describe('equalPowerGains', () => {
  it('gives full A, centre and full B at the ends and middle', () => {
    expect(equalPowerGains(-1).a).toBeCloseTo(1, 12);
    expect(equalPowerGains(-1).b).toBeCloseTo(0, 12);
    expect(equalPowerGains(0).a).toBeCloseTo(Math.SQRT1_2, 12);
    expect(equalPowerGains(0).b).toBeCloseTo(Math.SQRT1_2, 12);
    expect(equalPowerGains(1).a).toBeCloseTo(0, 12);
    expect(equalPowerGains(1).b).toBeCloseTo(1, 12);
  });

  it('keeps total power constant across the whole throw', () => {
    for (let position = -1; position <= 1; position += 0.05) {
      const { a, b } = equalPowerGains(position);
      expect(a * a + b * b).toBeCloseTo(1, 12);
    }
  });

  it('clamps positions outside -1..1', () => {
    expect(equalPowerGains(-3)).toEqual(equalPowerGains(-1));
    expect(equalPowerGains(3)).toEqual(equalPowerGains(1));
  });
});
