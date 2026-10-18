/**
 * Regression checks for the analyser on a real library: the current analysis of each track
 * against a committed baseline (so any analyser change shows what it moved), against the
 * file's tags, and against the user's corrections stored in the app library (a track the
 * user had to fix is a known failure until the analyser agrees with the fix).
 */
import { hasCorrections, resolveOverrides } from '../src/audio/analysis/overrides';
import type { AnalysisOverrides, AudioAnalysis } from '../src/audio/analysis/types';

/** What is kept per track in the baseline: enough to see what changed, small enough to commit. */
export interface TrackSummary {
  bpm: number;
  bpmConfidence: number;
  firstBeatTime: number;
  downbeatConfidence: number;
  isConstant: boolean;
  residualMs: number;
  key: string;
  keyConfidence: number;
  keySource: string;
  lufs: number;
  bars: number;
  phrases: string;
  tagBpm?: number;
  tagKey?: string;
}

const PHRASE_SHORT = { intro: 'In', build: 'Bu', drop: 'Dr', breakdown: 'Bd', outro: 'Out' } as const;

export function summarizePhrases(analysis: AudioAnalysis): string {
  return analysis.phrases.map((p) => `${PHRASE_SHORT[p.label]}${p.bars}`).join(' ');
}

export function summarizeTrack(analysis: AudioAnalysis, tags: { bpm?: number; key?: string }): TrackSummary {
  return {
    bpm: +analysis.bpm.toFixed(3),
    bpmConfidence: analysis.bpmConfidence,
    firstBeatTime: +analysis.firstBeatTime.toFixed(4),
    downbeatConfidence: analysis.downbeatConfidence,
    isConstant: analysis.tempo.isConstant,
    residualMs: analysis.tempo.residualMs,
    key: analysis.key.camelot,
    keyConfidence: analysis.key.confidence,
    keySource: analysis.key.source,
    lufs: +analysis.loudness.integratedLufs.toFixed(2),
    bars: analysis.bars.lowDb.length,
    phrases: summarizePhrases(analysis),
    ...(tags.bpm !== undefined ? { tagBpm: tags.bpm } : {}),
    ...(tags.key !== undefined ? { tagKey: tags.key } : {}),
  };
}

export type TempoRelation = 'same' | 'octave' | 'ratio' | 'other';

/** How two tempos relate: equal, an octave apart, a 3:2 / 4:3 reading, or unrelated. */
export function tempoRelation(a: number, b: number, tolerance = 0.01): TempoRelation {
  if (!(a > 0) || !(b > 0)) return 'other';
  const ratio = a / b;
  const near = (target: number) => Math.abs(Math.log(ratio / target)) <= Math.log(1 + tolerance);
  if (near(1)) return 'same';
  if (near(2) || near(0.5)) return 'octave';
  if (near(1.5) || near(2 / 3) || near(4 / 3) || near(0.75)) return 'ratio';
  return 'other';
}

export interface GridShift {
  /** Beat-phase shift, ms, in (−period/2, period/2]: a nudge of the grid. */
  phaseMs: number;
  /** Whole beats the first downbeat moved, mod 4: another beat chosen as the bar line. */
  downbeatBeats: number;
}

/** How a track's grid moved between two analyses at (nearly) the same tempo. */
export function gridShift(before: TrackSummary, after: TrackSummary): GridShift {
  const period = 60 / after.bpm;
  const beats = (after.firstBeatTime - before.firstBeatTime) / period;
  const whole = Math.round(beats);
  const phaseMs = (beats - whole) * period * 1000;
  return { phaseMs: +phaseMs.toFixed(1), downbeatBeats: ((whole % 4) + 4) % 4 };
}

export interface TrackChange {
  name: string;
  /** Short codes: tempo:octave, grid:+12ms, downbeat:+1, key:8A→9A, phrases, constant. */
  changes: string[];
}

/** Tolerances below which a change is noise, not a change. */
const SAME_PHASE_MS = 2;
const SAME_BPM = 0.0005;

export function compareToBaseline(name: string, before: TrackSummary | undefined, after: TrackSummary): TrackChange {
  const changes: string[] = [];
  if (!before) return { name, changes: ['new'] };
  const relation = tempoRelation(after.bpm, before.bpm, SAME_BPM);
  if (relation !== 'same') changes.push(`tempo:${relation} ${before.bpm}→${after.bpm}`);
  else {
    const shift = gridShift(before, after);
    if (Math.abs(shift.phaseMs) > SAME_PHASE_MS) changes.push(`grid:${shift.phaseMs > 0 ? '+' : ''}${shift.phaseMs}ms`);
    if (shift.downbeatBeats !== 0) changes.push(`downbeat:+${shift.downbeatBeats}`);
  }
  if (after.key !== before.key) changes.push(`key:${before.key}→${after.key}`);
  if (after.phrases !== before.phrases) changes.push('phrases');
  if (after.isConstant !== before.isConstant) changes.push(after.isConstant ? 'now constant' : 'now drifting');
  return { name, changes };
}

export interface TagAgreement {
  tempo: TempoRelation | 'untagged';
  key: 'same' | 'relative' | 'other' | 'untagged';
}

/** Camelot codes a step apart on the wheel, or the relative major/minor, count as compatible. */
function camelotRelated(a: string, b: string): boolean {
  const parse = (code: string) => {
    const match = /^(\d{1,2})([AB])$/i.exec(code.trim());
    return match ? { number: Number(match[1]), letter: match[2].toUpperCase() } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  const step = Math.min(Math.abs(x.number - y.number), 12 - Math.abs(x.number - y.number));
  return (x.letter === y.letter && step === 1) || (x.letter !== y.letter && step === 0);
}

export function tagAgreement(summary: TrackSummary, detectedKey: string): TagAgreement {
  return {
    tempo: summary.tagBpm !== undefined ? tempoRelation(summary.bpm, summary.tagBpm, 0.02) : 'untagged',
    key:
      summary.tagKey === undefined
        ? 'untagged'
        : detectedKey === summary.tagKey
          ? 'same'
          : camelotRelated(detectedKey, summary.tagKey)
            ? 'relative'
            : 'other',
  };
}

/** A track the user corrected in the app: what the analyser still gets wrong by their ear. */
export interface CorrectionStatus {
  name: string;
  /** Empty when the current analysis already agrees with the user's corrections. */
  remaining: string[];
}

export function correctionStatus(name: string, analysis: AudioAnalysis, overrides: AnalysisOverrides): CorrectionStatus {
  const fixes = resolveOverrides(analysis, overrides);
  if (!hasCorrections(fixes)) return { name, remaining: [] };
  const remaining: string[] = [];
  if (fixes.tempoMultiplier !== 1) remaining.push(`tempo ×${fixes.tempoMultiplier}`);
  if (fixes.gridOffsetMs !== 0) remaining.push(`nudge ${fixes.gridOffsetMs > 0 ? '+' : ''}${fixes.gridOffsetMs.toFixed(1)} ms`);
  if (fixes.downbeatShift !== 0) remaining.push(`downbeat ${fixes.downbeatShift > 0 ? '+' : ''}${fixes.downbeatShift}`);
  if (fixes.key) remaining.push(`key ${fixes.key}`);
  if (fixes.phraseShift !== 0) remaining.push(`phrase ${fixes.phraseShift > 0 ? '+' : ''}${fixes.phraseShift}`);
  return { name, remaining };
}
