import { describe, expect, it } from 'vitest';
import type { Track } from '@/types';
import { dedupeTracks, mergeTracks } from './library';

function track(id: string, filePath: string, extra: Partial<Track> = {}): Track {
  return {
    id,
    filePath,
    fileName: filePath.split('/').pop()!,
    duration: 200,
    fileSize: 1,
    analysis: null,
    analysisStatus: 'pending',
    ...extra,
  };
}

const complete = { analysis: { bpm: 126 } as unknown as Track['analysis'], analysisStatus: 'complete' as const };

describe('dedupeTracks', () => {
  it('keeps one entry per file in first-seen order', () => {
    const tracks = [track('1', '/a.mp3'), track('2', '/b.mp3'), track('3', '/a.mp3'), track('4', '/b.mp3')];
    expect(dedupeTracks(tracks).map((t) => t.id)).toEqual(['1', '2']);
  });

  it('prefers the copy with corrections, then the analysed one', () => {
    const tracks = [
      track('plain', '/a.mp3'),
      track('analysed', '/a.mp3', complete),
      track('corrected', '/a.mp3', { overrides: { bpmMultiplier: 2 } as never }),
    ];
    expect(dedupeTracks(tracks).map((t) => t.id)).toEqual(['corrected']);
  });

  it('falls back to the file name when there is no path (browser mode)', () => {
    const tracks = [track('1', '', { fileName: 'x.mp3' }), track('2', '', { fileName: 'x.mp3' })];
    expect(dedupeTracks(tracks)).toHaveLength(1);
  });
});

describe('mergeTracks', () => {
  it('appends only files the library does not hold yet', () => {
    const existing = [track('1', '/a.mp3')];
    const merged = mergeTracks(existing, [track('2', '/a.mp3'), track('3', '/b.mp3'), track('4', '/b.mp3')]);
    expect(merged.map((t) => t.id)).toEqual(['1', '3']);
  });

  it('returns the same array when nothing is new', () => {
    const existing = [track('1', '/a.mp3')];
    expect(mergeTracks(existing, [track('2', '/a.mp3')])).toBe(existing);
  });

  it('squashes duplicates the library already holds', () => {
    const existing = [track('1', '/a.mp3'), track('2', '/a.mp3', complete), track('3', '/b.mp3')];
    expect(mergeTracks(existing, []).map((t) => t.id)).toEqual(['2', '3']);
  });

  it('upgrades a plain entry with a richer copy but keeps its id', () => {
    const existing = [track('kept', '/a.mp3')];
    const merged = mergeTracks(existing, [track('saved', '/a.mp3', complete)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('kept');
    expect(merged[0].analysisStatus).toBe('complete');
  });
});
