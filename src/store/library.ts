import type { Track } from '@/types';

/** What makes two entries the same track: the file on disk, or its name in browser mode. */
export function trackKey(track: Pick<Track, 'filePath' | 'fileName'>): string {
  return track.filePath || track.fileName;
}

/** Hand corrections and a finished analysis are worth more than a fresh import of the same file. */
function richness(track: Track): number {
  return (track.overrides ? 2 : 0) + (track.analysis && track.analysisStatus === 'complete' ? 1 : 0);
}

/** One entry per file, the richest copy, in the position of the first occurrence. */
export function dedupeTracks(tracks: Track[]): Track[] {
  const slot = new Map<string, number>();
  const out: Track[] = [];
  for (const track of tracks) {
    const key = trackKey(track);
    const index = slot.get(key);
    if (index === undefined) {
      slot.set(key, out.length);
      out.push(track);
    } else if (richness(track) > richness(out[index])) {
      out[index] = track;
    }
  }
  return out;
}

/**
 * Add `incoming` to `existing` without ever holding the same file twice;
 * duplicates already in `existing` (older saved libraries) are squashed too.
 * A richer copy of a known file replaces it in place but keeps the id the
 * decks and queue already point at. Returns `existing` itself when nothing changed.
 */
export function mergeTracks(existing: Track[], incoming: Track[]): Track[] {
  const unique = dedupeTracks(existing);
  let merged = unique.length === existing.length ? existing : unique;
  const slot = new Map(merged.map((track, index) => [trackKey(track), index]));
  for (const track of dedupeTracks(incoming)) {
    const index = slot.get(trackKey(track));
    if (index === undefined) {
      if (merged === existing) merged = [...existing];
      slot.set(trackKey(track), merged.length);
      merged.push(track);
    } else if (richness(track) > richness(merged[index])) {
      if (merged === existing) merged = [...existing];
      merged[index] = { ...track, id: merged[index].id };
    }
  }
  return merged;
}
