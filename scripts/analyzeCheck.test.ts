import { describe, expect, it } from 'vitest';
import { analyzeAudio } from '../src/audio/analysis/analyzeAudio';
import { editOverrides } from '../src/audio/analysis/overrides';
import { synthesizeTrack } from '../src/audio/analysis/syntheticTrack';
import { compareToBaseline, correctionStatus, gridShift, summarizeTrack, tagAgreement, tempoRelation } from './analyzeCheck';

const summary = (over: Partial<ReturnType<typeof summarizeTrack>> = {}) => ({
  bpm: 124,
  bpmConfidence: 0.9,
  firstBeatTime: 0.5,
  downbeatConfidence: 0.5,
  isConstant: true,
  residualMs: 1,
  key: '8A',
  keyConfidence: 0.6,
  keySource: 'audio',
  lufs: -9,
  bars: 120,
  phrases: 'In16 Dr64 Out16',
  ...over,
});

describe('tempoRelation', () => {
  it('classifies equal, octave, 3:2 / 4:3 and unrelated tempos', () => {
    expect(tempoRelation(124, 124.5)).toBe('same');
    expect(tempoRelation(62, 124)).toBe('octave');
    expect(tempoRelation(248, 124)).toBe('octave');
    expect(tempoRelation(128, 85.33)).toBe('ratio');
    expect(tempoRelation(96, 128)).toBe('ratio');
    expect(tempoRelation(100, 124)).toBe('other');
  });
});

describe('gridShift and compareToBaseline', () => {
  it('reads a nudge and a moved bar line apart', () => {
    const period = 60 / 124;
    const before = summary();
    const nudged = summary({ firstBeatTime: 0.5 + 0.012 });
    expect(gridShift(before, nudged)).toEqual({ phaseMs: 12, downbeatBeats: 0 });
    const barLine = summary({ firstBeatTime: 0.5 + 5 * period });
    expect(gridShift(before, barLine).downbeatBeats).toBe(1);
    expect(Math.abs(gridShift(before, barLine).phaseMs)).toBeLessThan(0.01);
  });

  it('lists what changed and nothing when nothing did', () => {
    const before = summary();
    expect(compareToBaseline('x', before, summary({ firstBeatTime: 0.5011 })).changes).toEqual([]);
    expect(compareToBaseline('x', undefined, before).changes).toEqual(['new']);
    const changed = compareToBaseline('x', before, summary({ bpm: 62, key: '9A', phrases: 'In16 Dr80' }));
    expect(changed.changes[0]).toMatch(/^tempo:octave/);
    expect(changed.changes).toContain('key:8A→9A');
    expect(changed.changes).toContain('phrases');
  });
});

describe('tagAgreement', () => {
  it('relates the analysis to the file tags', () => {
    expect(tagAgreement(summary({ tagBpm: 124, tagKey: '8A' }), '8A')).toEqual({ tempo: 'same', key: 'same' });
    expect(tagAgreement(summary({ tagBpm: 62, tagKey: '8B' }), '8A')).toEqual({ tempo: 'octave', key: 'relative' });
    expect(tagAgreement(summary({ tagBpm: 93, tagKey: '2A' }), '8A')).toEqual({ tempo: 'ratio', key: 'other' });
    expect(tagAgreement(summary(), '8A')).toEqual({ tempo: 'untagged', key: 'untagged' });
  });
});

describe('correctionStatus', () => {
  it('reports the corrections a user made that the analyser still needs, and none once it agrees', () => {
    const track = synthesizeTrack({
      bpm: 124,
      firstDownbeat: 0.5,
      sections: [{ bars: 24, kick: true, clap: true, hats: true, bass: true, chords: true }],
    });
    const analysis = analyzeAudio(track.channels, track.sampleRate);
    const overrides = editOverrides(analysis, editOverrides(analysis, undefined, { type: 'downbeat', steps: 1 }), {
      type: 'key',
      camelot: '3B',
    })!;
    const status = correctionStatus('t', analysis, overrides);
    expect(status.remaining).toEqual(['downbeat +1', 'key 3B']);
    expect(correctionStatus('t', analysis, editOverrides(analysis, undefined, { type: 'reset' }) ?? {}).remaining).toEqual([]);
  });
});
