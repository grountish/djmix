import { describe, expect, it } from 'vitest';
import { analyzeAudio } from './analyzeAudio';
import { synthesizeTrack } from './syntheticTrack';
import { applyTempoHint, normalizeBpm } from './tempo';

describe('applyTempoHint', () => {
  it('picks the octave of the estimate a tag names', () => {
    expect(applyTempoHint(140, 70)).toBe(70);
    expect(applyTempoHint(85, 170)).toBe(170);
    expect(applyTempoHint(124, 124)).toBe(124);
    // Tags are rounded; 5% off still names the octave.
    expect(applyTempoHint(140.2, 72)).toBeCloseTo(70.1, 6);
  });

  it('leaves the estimate alone when the tag names no octave of it', () => {
    expect(applyTempoHint(124, 100)).toBe(124);
    // 3:2 and 4:3 readings are a different rhythm, not an octave.
    expect(applyTempoHint(128, 85.3)).toBe(128);
    expect(applyTempoHint(128, 96)).toBe(128);
    expect(applyTempoHint(124, undefined)).toBe(124);
    expect(applyTempoHint(124, 0)).toBe(124);
    expect(applyTempoHint(124, NaN)).toBe(124);
  });

  it('is what the analyser applies: a tagged 70 BPM keeps a half-time track out of the 85–175 fold', () => {
    const sections = [{ bars: 24, kick: true, clap: true, hats: true, bass: true, chords: true }];
    const track = synthesizeTrack({ bpm: 70, firstDownbeat: 0.4, sections });
    const untagged = analyzeAudio(track.channels, track.sampleRate);
    const tagged = analyzeAudio(track.channels, track.sampleRate, { bpm: 70 });
    expect(normalizeBpm(70)).toBe(140);
    expect(untagged.bpm).toBeCloseTo(140, 1);
    expect(tagged.bpm).toBeCloseTo(70, 1);
    // The same grid at half the beats: bars line up with the true downbeats.
    const bar = (4 * 60) / 70;
    const phase = ((((tagged.firstBeatTime - 0.4) % bar) + bar * 1.5) % bar) - bar / 2;
    expect(Math.abs(phase)).toBeLessThan(0.01);
  });
});
