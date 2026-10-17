import { describe, expect, it } from 'vitest';
import { decodeWaveform, encodeWaveform } from './waveformCache';

function band(samples: number, seed: number): number[] {
  return Array.from({ length: samples }, (_, i) => ((i * seed) % 97) / 97);
}

describe('waveform cache format', () => {
  it('round-trips all four bands within 16-bit precision', () => {
    const spectral = { low: band(50, 7), mid: band(50, 11), high: band(50, 13), combined: band(50, 17) };
    const decoded = decodeWaveform(encodeWaveform(spectral));
    expect(decoded).not.toBeNull();
    for (const key of ['low', 'mid', 'high', 'combined'] as const) {
      expect(decoded!.spectralWaveform[key]).toHaveLength(50);
      decoded!.spectralWaveform[key].forEach((v, i) => expect(v).toBeCloseTo(spectral[key][i], 4));
    }
    expect(decoded!.waveformData).toBe(decoded!.spectralWaveform.combined);
  });

  it('clamps out-of-range and NaN values instead of wrapping', () => {
    const spectral = { low: [1.5, -0.2, NaN], mid: [0, 0, 0], high: [0, 0, 0], combined: [0.5, 0.5, 0.5] };
    const decoded = decodeWaveform(encodeWaveform(spectral))!;
    expect(decoded.spectralWaveform.low).toEqual([1, 0, 0]);
  });

  it('rejects truncated, foreign and future-version files', () => {
    const spectral = { low: [0.1, 0.2], mid: [0.3, 0.4], high: [0.5, 0.6], combined: [0.7, 0.8] };
    const bytes = encodeWaveform(spectral);
    expect(decodeWaveform(bytes.subarray(0, bytes.length - 1))).toBeNull();
    expect(decodeWaveform(new TextEncoder().encode('{"waveform":[]}'))).toBeNull();
    const future = new Uint8Array(bytes);
    future[4] = 2;
    expect(decodeWaveform(future)).toBeNull();
    expect(decodeWaveform(new Uint8Array(3))).toBeNull();
  });

  it('decodes from a view into a larger buffer', () => {
    const spectral = { low: [0.25], mid: [0.5], high: [0.75], combined: [1] };
    const bytes = encodeWaveform(spectral);
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    const decoded = decodeWaveform(padded.subarray(4, 4 + bytes.length))!;
    expect(decoded.spectralWaveform.high[0]).toBeCloseTo(0.75, 4);
  });
});
