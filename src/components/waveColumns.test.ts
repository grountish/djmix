import { describe, expect, it } from 'vitest';
import { waveColumn } from './waveColumns';

// 100 s at 16 bins a second (a 4800-bin waveform of a 5-minute track has about that), a peak
// every 8 bins (a kick every half second).
const DURATION = 100;
const DATA = Array.from({ length: 1600 }, (_, i) => (i % 8 === 0 ? 1 : 0.2 + 0.1 * Math.sin(i)));

describe('waveColumn', () => {
  it('reads a column off the track, not off the view: the same column whatever the scroll', () => {
    // A view that starts at a fractional time draws column k at x = k − round(start · pps); the
    // column itself never changes, so scrolling only moves it.
    const pps = 70;
    const columns = (start: number) => {
      const offset = Math.round(start * pps);
      return Array.from({ length: 50 }, (_, x) => waveColumn(DATA, DURATION, pps, offset + x));
    };
    const a = columns(10);
    const b = columns(10 + 3 / pps);
    expect(b.slice(0, 47)).toEqual(a.slice(3));
  });

  it('keeps every peak when a column spans half a bin or more', () => {
    // 32 bars at 124 BPM over 1100 px: about 0.9 bins a pixel; at 10 px a second, 1.6 bins.
    for (const pps of [10, 17.3]) {
      const peaks = new Set<number>();
      for (let k = 0; k < DURATION * pps; k++) {
        const column = waveColumn(DATA, DURATION, pps, k);
        if (column.amplitude === 1) peaks.add(column.bin);
      }
      expect(peaks.size).toBe(DATA.length / 8);
    }
  });

  it('interpolates between bin centres when a bin spans several columns', () => {
    // 4 px a bin: the two columns either side of a bin's centre show it almost exactly.
    const pps = 64;
    const centre = 8 * 4 + 1.5; // bin 8 covers columns 32–35; its centre is between 33 and 34
    const atCentre = (waveColumn(DATA, DURATION, pps, Math.floor(centre)).amplitude + waveColumn(DATA, DURATION, pps, Math.ceil(centre)).amplitude) / 2;
    expect(atCentre).toBeGreaterThan(0.9);
    expect(waveColumn(DATA, DURATION, pps, 35).bin).toBe(8);
    expect(waveColumn(DATA, DURATION, pps, 0).amplitude).toBeLessThanOrEqual(1);
  });
});
