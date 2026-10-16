import { RealFFT, hannWindow } from './dsp';

const FRAME_SIZE = 2048;
const HOP = 512;

/** Band edges shared with the mixer's 3-band isolator. */
export const LOW_MID_CROSSOVER = 200;
export const MID_HIGH_CROSSOVER = 2500;

/** Compression applied to magnitudes before spectral flux. */
const FLUX_COMPRESSION = 1000;

/** Frame-rate features from one STFT pass. Frame i is centred at i · hop samples. */
export interface SpectralFeatures {
  sampleRate: number;
  hop: number;
  frames: number;
  /** Positive log-spectral flux over all bins: general onset strength. */
  flux: Float32Array;
  /** Flux below 150 Hz: kick onsets. */
  fluxLow: Float32Array;
  /** Flux 1–5 kHz: claps and snares. */
  fluxMid: Float32Array;
  lowPower: Float32Array;
  midPower: Float32Array;
  highPower: Float32Array;
  /** frames × 12 pitch-class energies (C = 0). */
  chroma: Float32Array;
}

export function frameTime(features: SpectralFeatures, frame: number): number {
  return (frame * features.hop) / features.sampleRate;
}

export function frameAt(features: SpectralFeatures, time: number): number {
  return Math.round((time * features.sampleRate) / features.hop);
}

export function computeSpectralFeatures(samples: Float32Array, sampleRate: number): SpectralFeatures {
  const frames = Math.floor(samples.length / HOP) + 1;
  const bins = FRAME_SIZE / 2 + 1;
  const binHz = sampleRate / FRAME_SIZE;
  const fft = new RealFFT(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);

  const lowEnd = Math.floor(LOW_MID_CROSSOVER / binHz);
  const midEnd = Math.floor(MID_HIGH_CROSSOVER / binHz);
  const kickEnd = Math.floor(150 / binHz);
  const clapStart = Math.ceil(1000 / binHz);
  const clapEnd = Math.min(bins - 1, Math.floor(5000 / binHz));

  const pitchClass = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const hz = k * binHz;
    if (hz < 65 || hz > 2100) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    pitchClass[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const features: SpectralFeatures = {
    sampleRate,
    hop: HOP,
    frames,
    flux: new Float32Array(frames),
    fluxLow: new Float32Array(frames),
    fluxMid: new Float32Array(frames),
    lowPower: new Float32Array(frames),
    midPower: new Float32Array(frames),
    highPower: new Float32Array(frames),
    chroma: new Float32Array(frames * 12),
  };

  const frame = new Float64Array(FRAME_SIZE);
  const re = new Float64Array(bins);
  const im = new Float64Array(bins);
  let previous = new Float64Array(bins);
  let current = new Float64Array(bins);
  const scale = 2 / FRAME_SIZE;

  for (let f = 0; f < frames; f++) {
    const start = f * HOP - FRAME_SIZE / 2;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const s = start + i;
      frame[i] = s >= 0 && s < samples.length ? samples[s] * window[i] : 0;
    }
    fft.forward(frame, re, im);

    let flux = 0;
    let fluxLow = 0;
    let fluxMid = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    const chromaOffset = f * 12;

    for (let k = 0; k < bins; k++) {
      const magnitude = Math.hypot(re[k], im[k]) * scale;
      const power = magnitude * magnitude;
      if (k <= lowEnd) low += power;
      else if (k <= midEnd) mid += power;
      else high += power;

      const pc = pitchClass[k];
      if (pc >= 0) features.chroma[chromaOffset + pc] += magnitude;

      const compressed = Math.log1p(FLUX_COMPRESSION * magnitude);
      current[k] = compressed;
      const rise = compressed - previous[k];
      if (rise > 0 && f > 0) {
        flux += rise;
        if (k <= kickEnd) fluxLow += rise;
        else if (k >= clapStart && k <= clapEnd) fluxMid += rise;
      }
    }

    features.flux[f] = flux;
    features.fluxLow[f] = fluxLow;
    features.fluxMid[f] = fluxMid;
    features.lowPower[f] = low;
    features.midPower[f] = mid;
    features.highPower[f] = high;

    const swap = previous;
    previous = current;
    current = swap;
  }

  return features;
}
