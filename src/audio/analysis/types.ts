/** Bumped whenever analysis output changes, so cached results are recomputed. */
export const ANALYZER_VERSION = 7;

export type PhraseLabel = 'intro' | 'build' | 'drop' | 'breakdown' | 'outro';

/** A run of bars with one role in the track structure. */
export interface Phrase {
  startBar: number;
  bars: number;
  label: PhraseLabel;
  hasKick: boolean;
  /** Sustained low end between kicks (a bassline), not just the kick itself. */
  hasBass: boolean;
  energyDb: number;
}

/** Per-bar band levels in dB, bar 0 starting at `firstBeatTime`. */
export interface BarEnergies {
  lowDb: number[];
  midDb: number[];
  highDb: number[];
  /** Low band between kicks: high when a bassline plays. */
  bassDb: number[];
}

export interface GridAnchor {
  beat: number;
  time: number;
}

export interface AudioAnalysis {
  analyzerVersion: number;
  bpm: number;
  bpmConfidence: number;
  /** First downbeat (bar line) at or after 0 s; bars repeat every 4 beats from here. */
  firstBeatTime: number;
  downbeatConfidence: number;
  tempo: {
    isConstant: boolean;
    /** RMS deviation of measured kicks from the fitted grid. */
    residualMs: number;
    /** Measured beat positions, kept only when the tempo drifts. */
    anchors?: GridAnchor[];
  };
  bars: BarEnergies;
  phrases: Phrase[];
  loudness: {
    integratedLufs: number;
    truePeakDb: number;
  };
  key: TrackKey;
}

export interface TrackKey {
  /** Pitch class of the tonic, C = 0. */
  tonic: number;
  mode: 'major' | 'minor';
  /** Camelot wheel code, e.g. "8A". */
  camelot: string;
  /** Margin over the next-best key (0–1); tags and manual keys count as 1. */
  confidence: number;
  source: 'tag' | 'audio' | 'manual';
}

export type TempoMultiplier = 0.5 | 1 | 2;

/**
 * Corrections the user made to a track's analysis. They live on the library track, apart from
 * the analysis, so a re-analysis keeps them; `applyOverrides` turns them into a corrected
 * analysis.
 */
export interface AnalysisOverrides {
  /** Tempo octave fix: 2 when the analyser heard half-time, 0.5 when it heard double-time. */
  tempoMultiplier?: TempoMultiplier;
  /** Moves the whole grid later (positive) or earlier, in milliseconds. */
  gridOffsetMs?: number;
  /**
   * Moves the first downbeat, counted in analysed beats. After ×2 a step is half an analysed
   * beat (one corrected beat); after ÷2 a step is one analysed beat (half a corrected beat), so
   * an odd shift picks the other half of the analysed beats as the real ones.
   */
  downbeatShift?: number;
  /** Camelot code replacing the tagged or detected key. */
  key?: string;
  /**
   * Moves every phrase boundary (and so the 8-bar phrase grid that cues and entries sit on)
   * this many bars later (negative: earlier). Relative to the analysed phrases.
   */
  phraseShift?: number;
  /**
   * The analysed grid the grid corrections were made on, and the bar line they produced (s).
   * When a re-analysis moves the grid, the corrections are re-expressed against the new one.
   */
  basis?: { bpm: number; firstBeatTime: number; downbeat: number };
}
