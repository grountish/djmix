import { describe, expect, it } from 'vitest';
import { eqKnobToGain, equalPowerGains, filterKnobToCutoffs } from './curves';

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

describe('eqKnobToGain', () => {
  it('kills at the bottom, is unity in the middle and +6 dB at the top', () => {
    expect(eqKnobToGain(-1)).toBe(0);
    expect(eqKnobToGain(0)).toBe(1);
    expect(20 * Math.log10(eqKnobToGain(1))).toBeCloseTo(6, 9);
    expect(20 * Math.log10(eqKnobToGain(-0.5))).toBeCloseTo(-12.04, 2);
  });
});

describe('filterKnobToCutoffs', () => {
  const nyquist = 22050;

  it('leaves both filters transparent at the centre', () => {
    expect(filterKnobToCutoffs(0, nyquist)).toEqual({ lowpassHz: nyquist, highpassHz: 0 });
  });

  it('sweeps the low-pass to 150 Hz and the high-pass to 8 kHz', () => {
    expect(filterKnobToCutoffs(-1, nyquist).lowpassHz).toBeCloseTo(150, 6);
    expect(filterKnobToCutoffs(1, nyquist).highpassHz).toBeCloseTo(8000, 6);
    // Exponential: halfway is the geometric mean.
    expect(filterKnobToCutoffs(-0.5, nyquist).lowpassHz).toBeCloseTo(Math.sqrt(20000 * 150), 6);
  });
});
