import { describe, expect, it } from 'vitest';
import { crossfaderGains, eqGainToKnob, eqKnobToGain, filterKnobToCutoffs } from './curves';

describe('crossfaderGains', () => {
  it('plays both decks at full level in the centre and one at each side', () => {
    expect(crossfaderGains(0)).toEqual({ a: 1, b: 1 });
    expect(crossfaderGains(-1).a).toBe(1);
    expect(crossfaderGains(-1).b).toBeCloseTo(0, 12);
    expect(crossfaderGains(1).a).toBeCloseTo(0, 12);
    expect(crossfaderGains(1).b).toBe(1);
  });

  it('fades the far deck along a quarter cosine', () => {
    expect(crossfaderGains(0.5).a).toBeCloseTo(Math.SQRT1_2, 12);
    expect(crossfaderGains(-0.5).b).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('clamps positions outside -1..1', () => {
    expect(crossfaderGains(-3)).toEqual(crossfaderGains(-1));
    expect(crossfaderGains(3)).toEqual(crossfaderGains(1));
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

describe('eqGainToKnob', () => {
  it('inverts eqKnobToGain across the knob range', () => {
    for (const knob of [-1, -0.75, -0.5, -0.1, 0, 0.3, 1]) {
      expect(eqGainToKnob(eqKnobToGain(knob))).toBeCloseTo(knob, 9);
    }
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
