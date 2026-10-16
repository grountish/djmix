import { describe, expect, it } from 'vitest';
import { analyzeAudio } from './analyzeAudio';
import { anchoredClock } from './beatClock';
import { measureLoudness } from './loudness';
import { synthesizeTrack, type SyntheticSection } from './syntheticTrack';

const FULL = { kick: true, clap: true, hats: true, bass: true, chords: true };
const HOUSE_ARRANGEMENT: SyntheticSection[] = [
  { bars: 16, kick: true, hats: true },
  { bars: 32, ...FULL },
  { bars: 16, chords: true, hats: true },
  { bars: 8, chords: true, clap: true, hats: true },
  { bars: 48, ...FULL },
  { bars: 16, kick: true, hats: true },
];

/** Signed distance from `time` to the nearest bar line of a grid through `downbeat`. */
function barPhaseError(time: number, downbeat: number, bpm: number): number {
  const bar = (4 * 60) / bpm;
  return ((((time - downbeat) % bar) + bar * 1.5) % bar) - bar / 2;
}

describe('track analysis', () => {
  it('locks a constant-tempo grid, its downbeats and its phrases', () => {
    const track = synthesizeTrack({ bpm: 123.45, firstDownbeat: 0.37, sections: HOUSE_ARRANGEMENT });
    const analysis = analyzeAudio(track.channels, track.sampleRate);
    const period = 60 / analysis.bpm;

    expect(analysis.bpm).toBeCloseTo(123.45, 3);
    expect(analysis.tempo.isConstant).toBe(true);

    // Every true beat over 4.4 minutes against the fitted grid.
    const errors = track.beatTimes.map((time) => {
      const beat = Math.round((time - analysis.firstBeatTime) / period);
      return analysis.firstBeatTime + beat * period - time;
    });
    expect(Math.max(...errors) - Math.min(...errors)).toBeLessThan(0.0001); // no drift
    expect(Math.abs(errors[0])).toBeLessThan(0.002); // kick attack sits within 2 ms

    expect(Math.abs(barPhaseError(analysis.firstBeatTime, 0.37, 123.45))).toBeLessThan(0.002);
    expect(analysis.phrases.map((p) => p.startBar)).toEqual([0, 16, 48, 72, 120]);
    expect(analysis.phrases.map((p) => p.label)).toEqual(['intro', 'drop', 'build', 'drop', 'outro']);
    expect(analysis.bars.lowDb).toHaveLength(136);
  });

  it('keeps slower house in its own octave', () => {
    const track = synthesizeTrack({ bpm: 100, firstDownbeat: 1.234, sections: HOUSE_ARRANGEMENT });
    expect(analyzeAudio(track.channels, track.sampleRate).bpm).toBeCloseTo(100, 2);
  });

  it('finds the downbeat from chord changes when there are no claps', () => {
    const track = synthesizeTrack({
      bpm: 126,
      firstDownbeat: 0.7,
      sections: [
        { bars: 8, kick: true, hats: true },
        { bars: 48, kick: true, hats: true, bass: true, chords: true },
        { bars: 8, kick: true, hats: true },
      ],
    });
    const analysis = analyzeAudio(track.channels, track.sampleRate);
    expect(Math.abs(barPhaseError(analysis.firstBeatTime, 0.7, 126))).toBeLessThan(0.002);
  });

  it('follows drifting tempo through a breakdown without losing the beat count', () => {
    const track = synthesizeTrack({ bpm: 120, endBpm: 124, firstDownbeat: 0.5, sections: HOUSE_ARRANGEMENT });
    const analysis = analyzeAudio(track.channels, track.sampleRate);

    expect(analysis.tempo.isConstant).toBe(false);
    const clock = anchoredClock(analysis.tempo.anchors!, 60 / analysis.bpm);
    // Beat 0 is the first downbeat, which is the first true beat.
    const kickBars = new Set<number>();
    HOUSE_ARRANGEMENT.reduce((bar, section) => {
      if (section.kick) for (let b = bar; b < bar + section.bars; b++) kickBars.add(b);
      return bar + section.bars;
    }, 0);
    track.beatTimes.forEach((time, beat) => {
      if (kickBars.has(Math.floor(beat / 4))) expect(Math.abs(clock.timeOf(beat) - time)).toBeLessThan(0.005);
    });
    expect(analysis.phrases.map((p) => p.startBar)).toEqual([0, 16, 48, 72, 120]);
  });
});

describe('measureLoudness', () => {
  const sampleRate = 44100;
  const sine = (amplitude: number, hz: number, phase = 0) => {
    const x = new Float32Array(sampleRate * 10);
    for (let i = 0; i < x.length; i++) x[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase);
    return x;
  };

  it('reads a -23 dBFS 1 kHz stereo sine as -23 LUFS (EBU Tech 3341)', () => {
    const amplitude = Math.pow(10, -23 / 20);
    const { integratedLufs } = measureLoudness([sine(amplitude, 1000), sine(amplitude, 1000)], sampleRate);
    expect(integratedLufs).toBeCloseTo(-23, 1);
  });

  it('finds the true peak between samples', () => {
    // Samples of this sine never exceed 0.354 (-9 dBFS); the waveform peaks at 0.5 (-6 dBTP).
    const { truePeakDb } = measureLoudness([sine(0.5, sampleRate / 4, Math.PI / 4)], sampleRate);
    expect(truePeakDb).toBeGreaterThan(-6.3);
    expect(truePeakDb).toBeLessThan(-5.8);
  });
});
