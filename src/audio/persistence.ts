import type { Track, CachedAnalysis, TrackAnalysis } from '@/types';
import { createFileFingerprint, fingerprintToKey } from './fileImporter';

export async function getCachedAnalysis(track: Track): Promise<CachedAnalysis | null> {
  const fingerprint = createFileFingerprint(track);
  const key = fingerprintToKey(fingerprint);

  try {
    return await window.electronAPI.cacheRead(key);
  } catch (error) {
    console.error('Failed to read from cache:', error);
    return null;
  }
}

export async function setCachedAnalysis(track: Track, analysis: TrackAnalysis): Promise<boolean> {
  const fingerprint = createFileFingerprint(track);
  const key = fingerprintToKey(fingerprint);

  const cached: CachedAnalysis = {
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    firstBeatTime: analysis.firstBeatTime,
    analyzedAt: analysis.analyzedAt,
    duration: track.duration,
  };

  try {
    return await window.electronAPI.cacheWrite(key, cached);
  } catch (error) {
    console.error('Failed to write to cache:', error);
    return false;
  }
}

export async function loadAllCachedAnalysis(): Promise<Record<string, CachedAnalysis>> {
  try {
    return await window.electronAPI.cacheReadAll();
  } catch (error) {
    console.error('Failed to load cache:', error);
    return {};
  }
}

export function createAnalysisFromCache(cached: CachedAnalysis, cacheKey: string): TrackAnalysis {
  return {
    bpm: cached.bpm,
    bpmConfidence: cached.bpmConfidence,
    firstBeatTime: cached.firstBeatTime ?? 0,
    analyzedAt: cached.analyzedAt,
    cacheKey,
  };
}
