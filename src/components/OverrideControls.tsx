import type { MouseEvent } from 'react';
import type { AnalysisOverrides, AudioAnalysis } from '@/types';
import { fromCamelot, keyName } from '@/audio/analysis/key';
import {
  downbeatStep,
  editOverrides,
  hasCorrections,
  resolveOverrides,
  type OverrideEdit,
} from '@/audio/analysis/overrides';

const NUDGE_MS = 5;
const FINE_NUDGE_MS = 1;

const camelotKeys = (letter: 'A' | 'B') =>
  Array.from({ length: 12 }, (_, i) => {
    const code = `${i + 1}${letter}`;
    return { code, label: `${code} · ${keyName(fromCamelot(code)!)}` };
  });
const MINOR_KEYS = camelotKeys('A');
const MAJOR_KEYS = camelotKeys('B');

function formatOffset(ms: number): string {
  if (ms === 0) return '0ms';
  const value = Number.isInteger(ms) ? Math.abs(ms) : Math.abs(ms).toFixed(1);
  return `${ms > 0 ? '+' : '−'}${value}ms`;
}

interface OverrideControlsProps {
  /** The analysis as analysed, before corrections. */
  analysis: AudioAnalysis;
  overrides?: AnalysisOverrides;
  onChange: (overrides: AnalysisOverrides | undefined) => void;
}

/** Deck row for fixing the analysis by ear: tempo octave, grid phase, downbeat and key. */
export function OverrideControls({ analysis, overrides, onChange }: OverrideControlsProps) {
  const fixes = resolveOverrides(analysis, overrides);
  const edit = (change: OverrideEdit) => onChange(editOverrides(analysis, overrides, change));
  const nudge = (direction: 1 | -1) => (e: MouseEvent) =>
    edit({ type: 'nudge', ms: direction * (e.shiftKey ? FINE_NUDGE_MS : NUDGE_MS) });
  // After ÷2 a downbeat step is one analysed beat: half a beat of the corrected grid.
  const halfBeat = downbeatStep(fixes.tempoMultiplier) * fixes.tempoMultiplier < 1;
  const step = halfBeat ? '½' : '1';
  const stepText = halfBeat ? 'half a beat (also picks which beats are real)' : 'one beat';
  const active = (on: boolean) => `fix-label ${on ? 'active' : ''}`;

  return (
    <div className="deck-fix-row">
      <div className="fix-group">
        <span className={active(fixes.tempoMultiplier !== 1)}>BPM</span>
        <button
          className="mode-button fix-button"
          onClick={() => edit({ type: 'tempo', factor: 0.5 })}
          disabled={fixes.tempoMultiplier === 0.5}
          title="Halve the tempo (the analysis heard double-time)">
          ÷2
        </button>
        <button
          className="mode-button fix-button"
          onClick={() => edit({ type: 'tempo', factor: 2 })}
          disabled={fixes.tempoMultiplier === 2}
          title="Double the tempo (the analysis heard half-time)">
          ×2
        </button>
      </div>

      <div className="fix-group">
        <span className={active(fixes.gridOffsetMs !== 0)}>Grid</span>
        <button
          className="mode-button fix-button"
          onClick={nudge(-1)}
          title={`Move the grid ${NUDGE_MS} ms earlier (Shift: ${FINE_NUDGE_MS} ms)`}>
          ◀
        </button>
        <span className="fix-readout">{formatOffset(fixes.gridOffsetMs)}</span>
        <button
          className="mode-button fix-button"
          onClick={nudge(1)}
          title={`Move the grid ${NUDGE_MS} ms later (Shift: ${FINE_NUDGE_MS} ms)`}>
          ▶
        </button>
      </div>

      <div className="fix-group">
        <span className={active(fixes.downbeatShift !== 0)}>Bar</span>
        <button
          className="mode-button fix-button"
          onClick={() => edit({ type: 'downbeat', steps: -1 })}
          title={`Move the downbeat ${stepText} earlier`}>
          −{step}
        </button>
        <button
          className="mode-button fix-button"
          onClick={() => edit({ type: 'downbeat', steps: 1 })}
          title={`Move the downbeat ${stepText} later`}>
          +{step}
        </button>
      </div>

      <div className="fix-group">
        <span className={active(fixes.phraseShift !== 0)}>Phrase</span>
        <button
          className="mode-button fix-button"
          onClick={() => edit({ type: 'phrase', bars: -1 })}
          title="Move the phrase lines (where mixes cue and enter) one bar earlier">
          −1
        </button>
        <span className="fix-readout">{fixes.phraseShift === 0 ? '0' : `${fixes.phraseShift > 0 ? '+' : ''}${fixes.phraseShift}`} bar</span>
        <button
          className="mode-button fix-button"
          onClick={() => edit({ type: 'phrase', bars: 1 })}
          title="Move the phrase lines (where mixes cue and enter) one bar later">
          +1
        </button>
      </div>

      <div className="fix-group">
        <span className={active(fixes.key !== null)}>Key</span>
        <select
          className={`fix-select ${fixes.key ? 'active' : ''}`}
          value={fixes.key ?? ''}
          onChange={(e) => edit({ type: 'key', camelot: e.target.value || null })}
          title="Key used for harmonic mixing">
          <option value="">Auto ({analysis.key.camelot})</option>
          <optgroup label="Minor">
            {MINOR_KEYS.map(({ code, label }) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Major">
            {MAJOR_KEYS.map(({ code, label }) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      <button
        className="mode-button fix-reset"
        onClick={() => edit({ type: 'reset' })}
        disabled={!hasCorrections(fixes)}
        title="Back to the analysed tempo, grid and key">
        Reset
      </button>
    </div>
  );
}
