import { describe, expect, it } from 'vitest';
import { RealFFT, filtfilt, lowpass, parabolicOffset } from './dsp';

describe('RealFFT', () => {
  it('matches a direct DFT', () => {
    const n = 64;
    const input = Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9) + (i % 5) * 0.1);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    new RealFFT(n).forward(input, re, im);

    for (let k = 0; k <= n / 2; k++) {
      let dr = 0;
      let di = 0;
      for (let t = 0; t < n; t++) {
        dr += input[t] * Math.cos((2 * Math.PI * k * t) / n);
        di -= input[t] * Math.sin((2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(dr, 9);
      expect(im[k]).toBeCloseTo(di, 9);
    }
  });
});

describe('filtfilt', () => {
  it('filters without shifting the signal in time', () => {
    const sampleRate = 8000;
    const x = new Float32Array(4000);
    x[2000] = 1;
    const y = filtfilt(x, [lowpass(200, sampleRate)]);
    let peak = 0;
    for (let i = 1; i < y.length; i++) if (y[i] > y[peak]) peak = i;
    expect(peak).toBe(2000);
  });
});

describe('parabolicOffset', () => {
  it('locates the vertex of a sampled parabola', () => {
    const f = (x: number) => -((x - 0.3) ** 2);
    expect(parabolicOffset(f(-1), f(0), f(1))).toBeCloseTo(0.3, 12);
  });
});
