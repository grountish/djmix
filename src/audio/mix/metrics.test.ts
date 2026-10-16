import { describe, expect, it } from 'vitest';
import { analyzeAudio } from '../analysis/analyzeAudio';
import { synthesizeTrack, type SyntheticSection } from '../analysis/syntheticTrack';
import {
  beatAlignment,
  kickOnsets,
  loudnessDeviation,
  lowBandCollisions,
  samplePeakDb,
  shortTermLoudness,
  summarizeTransition,
} from './metrics';

const SAMPLE_RATE = 44100;

/** Sine on [from, to) seconds, silence elsewhere. */
function tone(
  seconds: number,
  hz: number,
  amplitude: number,
  from = 0,
  to = seconds,
  phase = 0,
  sampleRate = SAMPLE_RATE,
): Float32Array {
  const x = new Float32Array(Math.round(seconds * sampleRate));
  const end = Math.min(x.length, Math.round(to * sampleRate));
  for (let i = Math.round(from * sampleRate); i < end; i++) {
    x[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase);
  }
  return x;
}

const mix = (...signals: Float32Array[]) => signals.reduce((sum, s) => sum.map((v, i) => v + s[i]));
const dbToAmplitude = (db: number) => Math.pow(10, db / 20);

function kickTrack(firstDownbeat: number, sections: SyntheticSection[], bpm = 124): Float32Array {
  return synthesizeTrack({ bpm, firstDownbeat, sections }).channels[0];
}

describe('beatAlignment', () => {
  // 124 BPM from 0.5 s: the 32 beats of an 8-bar overlap.
  const beats = synthesizeTrack({ bpm: 124, firstDownbeat: 0.5, sections: [{ bars: 8 }] })
    .beatTimes.slice(0, 32);

  it('measures a 3 ms lag between two different kick tracks', () => {
    const a = kickTrack(0.5, [{ bars: 8, kick: true, hats: true, bass: true }]);
    const b = kickTrack(0.503, [{ bars: 8, kick: true, clap: true, hats: true }]);
    const { beats: offsets, summary } = beatAlignment(a, b, SAMPLE_RATE, beats);

    expect(summary.count).toBe(32);
    expect(Math.abs(summary.meanMs - 3)).toBeLessThan(0.3);
    // Kicks start on whole samples, so the true lag is 132 or 133 samples (2.99 or 3.02 ms).
    for (const { diffMs } of offsets) expect(Math.abs(diffMs - 3)).toBeLessThan(0.3);
    expect(summary.maxAbsMs).toBeLessThan(3.3);
    expect(summary.p95AbsMs).toBeLessThanOrEqual(summary.maxAbsMs);
  });

  it('reads identical signals as aligned', () => {
    const a = kickTrack(0.5, [{ bars: 8, kick: true, hats: true, bass: true }]);
    const { summary } = beatAlignment(a, a.slice(), SAMPLE_RATE, beats);
    expect(summary).toEqual({ count: 32, meanMs: 0, maxAbsMs: 0, p95AbsMs: 0 });
  });

  it('ignores content above the kick band', () => {
    const a = kickTrack(0.5, [{ bars: 8, kick: true }]);
    const b = kickTrack(0.5, [{ bars: 8, kick: true, clap: true, hats: true }]);
    expect(beatAlignment(a, b, SAMPLE_RATE, beats).summary.maxAbsMs).toBeLessThan(0.01);
  });

  it('averages out bass and chord tones that beat against the kick', () => {
    // Read one kick at a time, a sustained 55 Hz sub moves this one's 50% point by up to 11 ms.
    const a = kickTrack(0.5, [{ bars: 8, kick: true }]);
    const chords = kickTrack(0.5, [{ bars: 8, kick: true, chords: true }]);
    const b = chords.map((v, i) => v + 0.2 * Math.sin((2 * Math.PI * 55 * i) / SAMPLE_RATE));
    const { summary } = beatAlignment(a, b, SAMPLE_RATE, beats);
    expect(summary.count).toBe(32);
    expect(summary.maxAbsMs).toBeLessThan(0.5);
  });

  it('still follows a sudden timing jump', () => {
    // b slips 8 ms late from the middle of beat 15 on (between kicks, where a is silent).
    const a = kickTrack(0.5, [{ bars: 8, kick: true }]);
    const slip = Math.round(0.008 * SAMPLE_RATE);
    const split = Math.round(((beats[15] + beats[16]) / 2) * SAMPLE_RATE);
    const b = a.map((v, i) => (i < split ? v : a[i - slip]));
    const { beats: offsets } = beatAlignment(a, b, SAMPLE_RATE, beats);
    for (const { beat, diffMs } of offsets) {
      if (beat <= 11) expect(Math.abs(diffMs)).toBeLessThan(0.1);
      if (beat >= 20) expect(Math.abs(diffMs - (1000 * slip) / SAMPLE_RATE)).toBeLessThan(0.1);
    }
  });

  it('skips beats where either signal has no kick', () => {
    const a = kickTrack(0.5, [
      { bars: 4, kick: true, hats: true, bass: true },
      { bars: 4, hats: true, clap: true, bass: true, chords: true },
    ]);
    const b = kickTrack(0.5, [{ bars: 8, kick: true, hats: true }]);
    const { beats: offsets, summary } = beatAlignment(a, b, SAMPLE_RATE, beats);
    expect(offsets.map((o) => o.beat)).toEqual(Array.from({ length: 16 }, (_, k) => k));
    expect(summary.count).toBe(16);
  });

  it('does not mistake the ripple of a sustained sub for kicks', () => {
    const groove = kickTrack(0.5, [{ bars: 4, kick: true }, { bars: 4, hats: true }]);
    const withSub = groove.map((v, i) => v + 0.3 * Math.sin((2 * Math.PI * 45 * i) / SAMPLE_RATE));
    const onsets = kickOnsets(withSub, SAMPLE_RATE, beats);
    expect(onsets.slice(0, 16).every((onset) => onset !== null)).toBe(true);
    expect(onsets.slice(16).every((onset) => onset === null)).toBe(true);
  });

  it('reports nothing for signals without kicks', () => {
    const silence = new Float32Array(10 * SAMPLE_RATE);
    const { beats: offsets, summary } = beatAlignment(silence, silence, SAMPLE_RATE, beats);
    expect(offsets).toEqual([]);
    expect(summary.count).toBe(0);
    expect(summary.maxAbsMs).toBeNaN();
  });

  it("places beats where the analyzer's grid does", () => {
    const track = synthesizeTrack({
      bpm: 123.45,
      firstDownbeat: 0.37,
      sections: [{ bars: 32, kick: true, clap: true, hats: true, bass: true, chords: true }],
    });
    const analysis = analyzeAudio(track.channels, track.sampleRate);
    const period = 60 / analysis.bpm;
    const grid = Array.from({ length: 120 }, (_, k) => analysis.firstBeatTime + k * period);
    const onsets = kickOnsets(track.channels[0], track.sampleRate, grid);
    onsets.forEach((onset, k) => expect(Math.abs(onset! - grid[k])).toBeLessThan(0.0003));
  });
});

describe('lowBandCollisions', () => {
  // 120 BPM: 16 beats from 0.5 s, each 0.5 s long.
  const beats = Array.from({ length: 16 }, (_, k) => 0.5 + 0.5 * k);
  const at = (beat: number) => 0.5 + 0.5 * beat;
  const mids = tone(9, 1000, 0.3);

  // a: bass on beats 0–9. b: bass 20 dB down on beats 0–5, full on 6–15.
  const a = mix(tone(9, 55, 0.5, at(0), at(10)), mids);
  const b = mix(tone(9, 55, 0.05, at(0), at(6)), tone(9, 55, 0.5, at(6), at(16)), mids);

  it('counts beats where both lows play', () => {
    const result = lowBandCollisions(a, b, SAMPLE_RATE, beats);
    expect(result.beats).toEqual([6, 7, 8, 9]);
    expect(result.collisions).toBe(4);
    expect(result.bDb[0]).toBeCloseTo(-20, 0);
  });

  it('applies the relative threshold', () => {
    expect(lowBandCollisions(a, b, SAMPLE_RATE, beats, -25).beats).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('never counts a deck without low end', () => {
    expect(lowBandCollisions(a, mids, SAMPLE_RATE, beats).collisions).toBe(0);
  });
});

describe('shortTermLoudness', () => {
  it('reads a -23 dBFS 1 kHz stereo sine as -23 LUFS (EBU Tech 3341)', () => {
    const amplitude = dbToAmplitude(-23);
    const series = shortTermLoudness([tone(10, 1000, amplitude), tone(10, 1000, amplitude)], SAMPLE_RATE);
    expect(series.times).toHaveLength(71);
    expect(series.times[0]).toBeCloseTo(1.5, 9);
    expect(series.times[1] - series.times[0]).toBeCloseTo(0.1, 9);
    for (const lufs of series.lufs) expect(Math.abs(lufs + 23)).toBeLessThan(0.1);
  });

  it('reads silence as a finite floor', () => {
    const series = shortTermLoudness([new Float32Array(4 * SAMPLE_RATE)], SAMPLE_RATE);
    for (const lufs of series.lufs) expect(lufs).toBeLessThan(-100);
  });
});

describe('loudnessDeviation', () => {
  it('reports a 6 dB step as 6 LU', () => {
    const quiet = dbToAmplitude(-20);
    const loud = dbToAmplitude(-14);
    const step = mix(tone(20, 1000, quiet, 0, 12), tone(20, 1000, loud, 12, 20));
    const series = shortTermLoudness([step, step], SAMPLE_RATE);
    expect(loudnessDeviation(series, 0, 20)).toBeCloseTo(6, 1);
    // Windows centred before 10.5 s end before the step.
    expect(loudnessDeviation(series, 0, 10.4)).toBeLessThan(0.01);
  });

  it('reads a steady signal as flat', () => {
    const steady = tone(20, 1000, 0.1);
    expect(loudnessDeviation(shortTermLoudness([steady, steady], SAMPLE_RATE), 0, 20)).toBeLessThan(0.01);
  });

  it('keeps a steady house groove within half a LU', () => {
    const track = synthesizeTrack({
      bpm: 124,
      firstDownbeat: 0.5,
      sections: [{ bars: 16, kick: true, clap: true, hats: true, bass: true, chords: true }],
    });
    const series = shortTermLoudness(track.channels, track.sampleRate);
    expect(loudnessDeviation(series, 3, 28)).toBeLessThan(0.5);
  });

  it('is NaN when no window falls in the range', () => {
    const series = shortTermLoudness([tone(5, 1000, 0.1)], SAMPLE_RATE);
    expect(loudnessDeviation(series, 10, 20)).toBeNaN();
  });
});

describe('samplePeakDb', () => {
  it('returns the loudest channel peak', () => {
    // 1 kHz at 48 kHz: sample 12 of each period lands on the crest.
    const channels = [tone(1, 1000, 0.25, 0, 1, 0, 48000), tone(1, 1000, 0.5, 0, 1, 0, 48000)];
    expect(samplePeakDb(channels)).toBeCloseTo(20 * Math.log10(0.5), 4);
  });

  it('reads silence as -120 dB', () => {
    expect(samplePeakDb([new Float32Array(100)])).toBeCloseTo(-120, 6);
  });
});

describe('summarizeTransition', () => {
  // 120 BPM overlap of 32 beats from 2 s to 18 s; bass swap on overlap beat 16 (10 s).
  const overlapBeatTimes = Array.from({ length: 32 }, (_, k) => 2 + 0.5 * k);
  const seconds = 20;

  function render(lagSeconds: number, incomingBassFrom: number, masterGain: number) {
    const outgoingLow = tone(seconds, 60, 0.3, 0, 10.5);
    // Quadrature with the outgoing bass, so the one-beat swap overlap adds power, not amplitude.
    const incomingLow = tone(seconds, 60, 0.3, incomingBassFrom, seconds, Math.PI / 2);
    const master = mix(outgoingLow, incomingLow).map((v) => v * masterGain);
    return {
      sampleRate: SAMPLE_RATE,
      timingTaps: {
        outgoing: kickTrack(2, [{ bars: 8, kick: true, hats: true }], 120),
        incoming: kickTrack(2 + lagSeconds, [{ bars: 8, kick: true, clap: true }], 120),
      },
      levelTaps: { outgoing: outgoingLow, incoming: incomingLow },
      master: [master, master.slice()],
      overlapBeatTimes,
      overlapStart: 2,
      overlapEnd: 18,
      allowedCollisionBeats: [16],
    };
  }

  it('passes a tight transition with a one-beat bass swap', () => {
    const metrics = summarizeTransition(render(0.001, 10, 1));
    expect(metrics.alignment.summary.count).toBe(32);
    expect(Math.abs(metrics.alignment.summary.meanMs - 1)).toBeLessThan(0.1);
    expect(metrics.collisions.beats).toEqual([16]);
    expect(metrics.unexpectedCollisionBeats).toEqual([]);
    expect(metrics.loudnessDeviationLu).toBeLessThan(1);
    expect(metrics.samplePeakDb).toBeLessThan(-1);
    expect(metrics.truePeakDb).toBeLessThan(-1);
    expect(metrics.checks).toEqual({ beatAlignment: true, lowBand: true, loudness: true, peak: true });
    expect(metrics.pass).toBe(true);
  });

  it('fails flams, early bass, loudness bumps and overs', () => {
    const metrics = summarizeTransition(render(0.008, 6, 3));
    expect(metrics.alignment.summary.maxAbsMs).toBeGreaterThan(7);
    expect(metrics.unexpectedCollisionBeats).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    expect(metrics.loudnessDeviationLu).toBeGreaterThan(2.5);
    expect(metrics.samplePeakDb).toBeGreaterThan(0);
    expect(metrics.checks).toEqual({ beatAlignment: false, lowBand: false, loudness: false, peak: false });
    expect(metrics.pass).toBe(false);
  });
});
