import { describe, expect, it } from 'vitest';
import { detectKey, fromCamelot, keyName, parseKeyTag, toCamelot, type MusicalKey } from './key';

const C_MAJOR: MusicalKey = { tonic: 0, mode: 'major' };
const A_MINOR: MusicalKey = { tonic: 9, mode: 'minor' };

describe('Camelot codes', () => {
  it('names keys on the wheel', () => {
    expect(toCamelot(C_MAJOR)).toBe('8B');
    expect(toCamelot(A_MINOR)).toBe('8A');
    expect(toCamelot({ tonic: 6, mode: 'minor' })).toBe('11A'); // F#m
    expect(toCamelot({ tonic: 1, mode: 'major' })).toBe('3B'); // Db
    expect(toCamelot({ tonic: 5, mode: 'major' })).toBe('7B'); // F
  });

  it('round-trips all 24 keys', () => {
    for (const mode of ['major', 'minor'] as const) {
      for (let tonic = 0; tonic < 12; tonic++) {
        expect(fromCamelot(toCamelot({ tonic, mode }))).toEqual({ tonic, mode });
      }
    }
  });
});

describe('parseKeyTag', () => {
  it('reads Open Key, Camelot and note names', () => {
    expect(parseKeyTag('1m')).toEqual(A_MINOR);
    expect(parseKeyTag('1d')).toEqual(C_MAJOR);
    expect(keyName(parseKeyTag('10d')!)).toBe('Eb');
    expect(parseKeyTag('8A')).toEqual(A_MINOR);
    expect(keyName(parseKeyTag('F#m')!)).toBe('F#m');
    expect(keyName(parseKeyTag('Bbm')!)).toBe('Bbm');
    expect(parseKeyTag('C major')).toEqual(C_MAJOR);
    expect(parseKeyTag('nonsense')).toBeNull();
    expect(parseKeyTag(undefined)).toBeNull();
  });
});

describe('detectKey', () => {
  const sampleRate = 44100;
  const midiHz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

  /** One bar per chord with a bass root, each note with a few harmonics. */
  function progression(chords: number[][], bass: number[], bars = 16, seconds = 2): Float32Array {
    const out = new Float32Array(Math.round(bars * seconds * sampleRate));
    for (let bar = 0; bar < bars; bar++) {
      const notes = [...chords[bar % chords.length], bass[bar % bass.length]];
      const start = Math.round(bar * seconds * sampleRate);
      for (let i = 0; i < seconds * sampleRate; i++) {
        let v = 0;
        for (const note of notes) {
          for (let h = 1; h <= 3; h++) v += Math.sin((2 * Math.PI * midiHz(note) * h * i) / sampleRate) / h;
        }
        out[start + i] = 0.05 * v;
      }
    }
    return out;
  }

  it('finds D minor in i – iv – V – i', () => {
    const audio = progression(
      [[62, 65, 69], [67, 70, 74], [69, 73, 76], [62, 65, 69]],
      [38, 43, 45, 38],
    );
    expect(toCamelot(detectKey(audio, sampleRate))).toBe(toCamelot({ tonic: 2, mode: 'minor' }));
  });

  it('finds E major in I – IV – V – I', () => {
    const audio = progression(
      [[64, 68, 71], [69, 73, 76], [71, 75, 78], [64, 68, 71]],
      [40, 45, 47, 40],
    );
    expect(toCamelot(detectKey(audio, sampleRate))).toBe(toCamelot({ tonic: 4, mode: 'major' }));
  });
});
