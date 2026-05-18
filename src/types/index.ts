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
}

export interface TrackAnalysis {
  bpm: number;
  bpmConfidence: number;
  manualBpm?: number;
  firstBeatTime: number; // Time in seconds of first detected beat
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
  targetBpm: number | null;
  playbackMode: PlaybackMode;
}

export type PlaybackMode = 'rate' | 'stretch';

export interface MixState {
  deckA: DeckState;
  deckB: DeckState;
  crossfader: number; // -1 (full A) to 1 (full B)
  masterVolume: number;
}

export interface BpmAnalyzerResult {
  bpm: number;
  confidence: number;
  firstBeatTime: number;
}

export interface BpmAnalyzer {
  analyze(audioBuffer: AudioBuffer): Promise<BpmAnalyzerResult>;
}

export interface CachedAnalysis {
  bpm: number;
  bpmConfidence: number;
  firstBeatTime: number;
  analyzedAt: string;
  duration: number;
}

export interface FileFingerprint {
  fileName: string;
  fileSize: number;
  duration: number;
}

export interface SortOption {
  field: 'fileName' | 'bpm' | 'duration';
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
