/** Bumped whenever analysis output changes, so cached results are recomputed. */
export const ANALYZER_VERSION = 3;

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
  /** Margin over the next-best key (0–1); tags count as 1. */
  confidence: number;
  source: 'tag' | 'audio';
}
