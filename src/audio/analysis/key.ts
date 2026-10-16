import { decimate, hannWindow, RealFFT } from './dsp';
import type { TrackKey } from './types';

export type KeyMode = 'major' | 'minor';

export interface MusicalKey {
  /** Pitch class of the tonic, C = 0. */
  tonic: number;
  mode: KeyMode;
}

export interface DetectedKey extends MusicalKey {
  /** Correlation of the track's pitch profile with the key profile (0–1). */
  strength: number;
  /** Margin over the next-best key that isn't the relative major/minor (0–1). */
  confidence: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * Key profiles, tonic first: the diatonic scale with tonic, fifth and third weighted up.
 * Electronic music leans on tonic and fifth; against 42 tagged tracks this matched the tags
 * better (57% exact, 67% weighted) than the Krumhansl (38%) or Temperley (21%) profiles,
 * which mostly confused relative major and minor.
 */
const PROFILES: Record<KeyMode, number[]> = {
  major: [2, 0, 1, 0, 1.5, 1, 0, 1.8, 0, 1, 0, 1],
  minor: [2, 0, 1, 1.5, 0, 1, 0, 1.8, 1, 0, 1, 0],
};

const ANALYSIS_RATE = 11025;
const FRAME_SIZE = 4096;
const HOP = 2048;
const MIN_HZ = 50;
const MAX_HZ = 3500;
const PEAKS_PER_FRAME = 60;
/** Peaks quieter than this below the frame's loudest peak are ignored. */
const PEAK_FLOOR_DB = -60;
/** Each peak also votes for the notes it could be the 2nd, 3rd… harmonic of. */
const HARMONICS = 4;
const HARMONIC_DECAY = 0.6;
/** Width of a peak's vote around its pitch, in semitones. */
const VOTE_WIDTH = 4 / 3;

export function keyName({ tonic, mode }: MusicalKey): string {
  return `${NOTE_NAMES[tonic]}${mode === 'minor' ? 'm' : ''}`;
}

/** Camelot wheel code: minor keys are A, major keys B; neighbours are a fifth apart. */
export function toCamelot({ tonic, mode }: MusicalKey): string {
  const major = mode === 'major' ? tonic : (tonic + 3) % 12;
  const number = ((((major * 7) % 12) + 7) % 12) + 1;
  return `${number}${mode === 'minor' ? 'A' : 'B'}`;
}

export function fromCamelot(code: string): MusicalKey | null {
  const match = /^(\d{1,2})([AB])$/i.exec(code.trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (number < 1 || number > 12) return null;
  // Inverse of toCamelot: number n is the major key (n - 8) fifths above C.
  const major = (((number - 8) * 7) % 12 + 12) % 12;
  return match[2].toUpperCase() === 'B'
    ? { tonic: major, mode: 'major' }
    : { tonic: (major + 9) % 12, mode: 'minor' };
}

/**
 * Reads key tags as written by DJ tools: Camelot ("8A"), Open Key ("1m", "1d") or note names
 * ("Am", "F#m", "Bb", "C major").
 */
export function parseKeyTag(tag: string | undefined | null): MusicalKey | null {
  if (!tag) return null;
  const text = tag.trim();

  const openKey = /^(\d{1,2})([dm])$/i.exec(text);
  if (openKey) {
    const number = Number(openKey[1]);
    if (number < 1 || number > 12) return null;
    const camelot = ((number + 6) % 12) + 1;
    return fromCamelot(`${camelot}${openKey[2].toLowerCase() === 'd' ? 'B' : 'A'}`);
  }

  const camelot = fromCamelot(text);
  if (camelot) return camelot;

  const note = /^([A-G])\s*([#♯b♭]?)\s*(m|min|minor|maj|major)?$/i.exec(text);
  if (!note) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[note[1].toUpperCase() as 'C'];
  const accidental = note[2] === '#' || note[2] === '♯' ? 1 : note[2] === 'b' || note[2] === '♭' ? -1 : 0;
  const quality = (note[3] ?? '').toLowerCase();
  const minor = quality === 'm' || quality === 'min' || quality === 'minor';
  return { tonic: (base + accidental + 12) % 12, mode: minor ? 'minor' : 'major' };
}

/** A tagged key, trusted over detection. */
export function keyFromTag(tag: string | undefined): TrackKey | null {
  const key = parseKeyTag(tag);
  return key ? { ...key, camelot: toCamelot(key), confidence: 1, source: 'tag' } : null;
}

/** Key from the track's harmonic pitch-class profile, matched against major/minor profiles. */
export function detectKey(mono: Float32Array, sampleRate: number): DetectedKey {
  const profile = pitchClassProfile(mono, sampleRate);
  const scores: { key: MusicalKey; score: number }[] = [];
  for (const mode of ['major', 'minor'] as const) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = PROFILES[mode].map((_, pc) => PROFILES[mode][(pc - tonic + 12) % 12]);
      scores.push({ key: { tonic, mode }, score: correlation(profile, rotated) });
    }
  }
  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];
  const relative = (k: MusicalKey) =>
    k.mode === 'major' ? { tonic: (k.tonic + 9) % 12, mode: 'minor' } : { tonic: (k.tonic + 3) % 12, mode: 'major' };
  const bestRelative = relative(best.key);
  const rival = scores.find(
    (s) => s !== best && !(s.key.tonic === bestRelative.tonic && s.key.mode === bestRelative.mode),
  )!;
  return {
    ...best.key,
    strength: Math.max(0, best.score),
    confidence: Math.max(0, Math.min(1, (best.score - rival.score) / Math.max(1e-9, Math.abs(best.score)))),
  };
}

/** 12-bin pitch-class energy (C = 0), tuning-corrected, summed over the track. */
export function pitchClassProfile(mono: Float32Array, sampleRate: number): number[] {
  const factor = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE));
  const samples = decimate(mono, sampleRate, factor);
  const rate = sampleRate / factor;
  const peaks = spectralPeaks(samples, rate);

  // Tuning: amplitude-weighted circular mean of each peak's distance from equal temperament.
  let sin = 0;
  let cos = 0;
  for (const frame of peaks) {
    for (const { hz, magnitude } of frame) {
      const semitones = 12 * Math.log2(hz / 440);
      const angle = 2 * Math.PI * (semitones - Math.round(semitones));
      sin += magnitude * Math.sin(angle);
      cos += magnitude * Math.cos(angle);
    }
  }
  const tuning = Math.atan2(sin, cos) / (2 * Math.PI);

  const profile = new Array<number>(12).fill(0);
  const frameProfile = new Array<number>(12);
  for (const frame of peaks) {
    frameProfile.fill(0);
    for (const { hz, magnitude } of frame) {
      for (let h = 1; h <= HARMONICS; h++) {
        // Position in semitones above C, corrected for tuning.
        const pitch = 12 * Math.log2(hz / h / 440) - tuning + 9;
        const weight = magnitude * Math.pow(HARMONIC_DECAY, h - 1);
        for (let pc = 0; pc < 12; pc++) {
          const distance = Math.abs(((((pitch - pc) % 12) + 18) % 12) - 6);
          if (distance < VOTE_WIDTH / 2) {
            frameProfile[pc] += weight * Math.cos((Math.PI * distance) / VOTE_WIDTH) ** 2;
          }
        }
      }
    }
    const max = Math.max(...frameProfile);
    if (max > 0) for (let pc = 0; pc < 12; pc++) profile[pc] += frameProfile[pc] / max;
  }
  return profile;
}

function spectralPeaks(samples: Float32Array, rate: number): { hz: number; magnitude: number }[][] {
  const fft = new RealFFT(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);
  const bins = FRAME_SIZE / 2 + 1;
  const binHz = rate / FRAME_SIZE;
  const lo = Math.ceil(MIN_HZ / binHz);
  const hi = Math.min(bins - 2, Math.floor(MAX_HZ / binHz));
  const frame = new Float64Array(FRAME_SIZE);
  const re = new Float64Array(bins);
  const im = new Float64Array(bins);
  const db = new Float64Array(bins);
  const frames: { hz: number; magnitude: number }[][] = [];

  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP) {
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = samples[start + i] * window[i];
    fft.forward(frame, re, im);
    let loudest = -Infinity;
    for (let k = lo - 1; k <= hi + 1; k++) {
      db[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-12);
      if (k >= lo && k <= hi) loudest = Math.max(loudest, db[k]);
    }

    const found: { hz: number; magnitude: number }[] = [];
    for (let k = lo; k <= hi; k++) {
      if (db[k] <= db[k - 1] || db[k] < db[k + 1] || db[k] < loudest + PEAK_FLOOR_DB) continue;
      const denom = db[k - 1] - 2 * db[k] + db[k + 1];
      const offset = denom === 0 ? 0 : (0.5 * (db[k - 1] - db[k + 1])) / denom;
      const peakDb = db[k] - 0.25 * (db[k - 1] - db[k + 1]) * offset;
      found.push({ hz: (k + offset) * binHz, magnitude: Math.pow(10, peakDb / 20) });
    }
    found.sort((a, b) => b.magnitude - a.magnitude);
    frames.push(found.slice(0, PEAKS_PER_FRAME));
  }
  return frames;
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
