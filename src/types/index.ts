import type { AnalysisOverrides, AudioAnalysis } from '@/audio/analysis/types';

export type {
  AnalysisOverrides,
  AudioAnalysis,
  Phrase,
  PhraseLabel,
  TempoMultiplier,
  TrackKey,
} from '@/audio/analysis/types';
export type { EqBand } from '@/audio/engine/mixGraph';
import type { EqBand } from '@/audio/engine/mixGraph';

export interface SpectralWaveform {
  low: number[];
  mid: number[];
  high: number[];
  combined: number[];
}

export interface Track {
  id: string;
  filePath: string;
  fileName: string;
  duration: number;
  fileSize: number;
  analysis: TrackAnalysis | null;
  analysisStatus: AnalysisStatus;
  waveformData?: number[];
  spectralWaveform?: SpectralWaveform;
  artwork?: string; // Base64 data URL of album artwork
  artist?: string;
  title?: string;
  album?: string;
  /** Key as tagged in the file (Camelot, Open Key or note name). */
  tagKey?: string;
  /** BPM as tagged in the file. */
  tagBpm?: number;
  /** The user's corrections; read the analysis through `effectiveAnalysis(track)`. */
  overrides?: AnalysisOverrides;
}

export interface TrackAnalysis extends AudioAnalysis {
  /** @deprecated Never written; tempo fixes live in `Track.overrides`. */
  manualBpm?: number;
  analyzedAt: string;
  cacheKey: string;
}

export type AnalysisStatus = 'pending' | 'analyzing' | 'complete' | 'error';

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  volume: number;
}

export interface DeckState {
  track: Track | null;
  playback: PlaybackState;
  /** Cue point (track seconds): set by CUE while paused or by Auto when it cues the next track. */
  cuePoint: number | null;
  targetBpm: number | null;
  playbackMode: PlaybackMode;
  /** EQ knob positions: -1 kill, 0 unity, +1 = +6 dB. */
  eq: Record<EqBand, number>;
  /** Filter knob: -1 low-pass … 0 off … +1 high-pass. */
  filter: number;
}

export type PlaybackMode = 'rate' | 'stretch';

export interface MixState {
  deckA: DeckState;
  deckB: DeckState;
  crossfader: number; // -1 (full A) to 1 (full B)
  masterVolume: number;
}

export interface CachedAnalysis extends AudioAnalysis {
  analyzedAt: string;
  duration: number;
}

export interface FileFingerprint {
  fileName: string;
  fileSize: number;
  duration: number;
}

export interface SortOption {
  field: 'title' | 'artist' | 'bpm' | 'key' | 'duration';
  direction: 'asc' | 'desc';
}

export interface FilterOptions {
  bpmMin?: number;
  bpmMax?: number;
  searchQuery?: string;
}

export interface ElectronAPI {
  openFileDialog: () => Promise<string[]>;
  readFile: (filePath: string) => Promise<Buffer>;
  getFileStats: (filePath: string) => Promise<{ size: number; mtime: string }>;
  cacheRead: (key: string) => Promise<CachedAnalysis | null>;
  cacheWrite: (key: string, value: CachedAnalysis) => Promise<boolean>;
  cacheReadAll: () => Promise<Record<string, CachedAnalysis>>;
  getAudioMetadata: (filePath: string) => Promise<{
    artwork?: string;
    artist?: string;
    title?: string;
    album?: string;
    tagKey?: string;
    tagBpm?: number;
  }>;
  librarySave: (tracks: Track[]) => Promise<boolean>;
  libraryLoad: () => Promise<Track[]>;
  libraryClear: () => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
