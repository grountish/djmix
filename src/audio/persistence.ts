import type { Track, CachedAnalysis, TrackAnalysis } from '@/types';
import { ANALYZER_VERSION } from './analysis/types';
import { createFileFingerprint, fingerprintToKey } from './fileImporter';

/** True when the analysis came from the current analyzer; older results are recomputed. */
export function isCurrentAnalysis(analysis: { analyzerVersion?: number } | null | undefined): boolean {
  return analysis?.analyzerVersion === ANALYZER_VERSION;
}

export async function getCachedAnalysis(track: Track): Promise<CachedAnalysis | null> {
  const fingerprint = createFileFingerprint(track);
  const key = fingerprintToKey(fingerprint);

  try {
    const cached = await window.electronAPI.cacheRead(key);
    return isCurrentAnalysis(cached) ? cached : null;
  } catch (error) {
    console.error('Failed to read from cache:', error);
    return null;
  }
}

export async function setCachedAnalysis(track: Track, analysis: TrackAnalysis): Promise<boolean> {
  const fingerprint = createFileFingerprint(track);
  const key = fingerprintToKey(fingerprint);

  const cached: CachedAnalysis = { ...analysis, duration: track.duration };

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
  return { ...cached, cacheKey };
}
