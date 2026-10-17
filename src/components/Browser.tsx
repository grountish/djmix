import { memo, useMemo, useState, type DragEvent } from 'react';
import type { FilterOptions, SortOption, Track } from '@/types';
import { effectiveAnalysis } from '@/audio/analysis/overrides';
import { harmonicScore } from '@/audio/mix/harmonic';
import type { TempoDirection } from '@/audio/mix/sequencer';
import { TRACK_DRAG_TYPE, formatTime } from './Deck';
import { KeyBadge } from './KeyBadge';

type DeckId = 'A' | 'B';
type View = 'collection' | 'queue' | 'history';

interface BrowserProps {
  tracks: Track[];
  queue: string[];
  played: string[];
  loaded: Record<DeckId, string | null>;
  playing: Record<DeckId, boolean>;
  sortOption: SortOption;
  filterOptions: FilterOptions;
  referenceTrackId: string | null;
  direction: TempoDirection;
  autoEnabled: boolean;
  onImport: () => void;
  onSortChange: (sort: SortOption) => void;
  onFilterChange: (filter: FilterOptions) => void;
  onLoad: (deck: DeckId, track: Track) => void;
  onToggleQueue: (trackId: string) => void;
  onMoveInQueue: (trackId: string, offset: number) => void;
  onSetReference: (trackId: string | null) => void;
  onDirectionChange: (direction: TempoDirection) => void;
  onSmartOrder: () => void;
}

const COLUMNS: { field: SortOption['field']; label: string; className: string }[] = [
  { field: 'title', label: 'Title', className: 'cell-title' },
  { field: 'artist', label: 'Artist', className: 'cell-artist' },
  { field: 'bpm', label: 'BPM', className: 'cell-bpm' },
  { field: 'key', label: 'Key', className: 'cell-key' },
  { field: 'duration', label: 'Time', className: 'cell-time' },
];

const bpmOf = (track: Track) => effectiveAnalysis(track)?.bpm;
const titleOf = (track: Track) => track.title || track.fileName.replace(/\.[^.]+$/, '');

/** Camelot order: 1A, 1B, 2A, … so neighbours on the wheel sit together. */
function keyOrder(track: Track): number {
  const key = effectiveAnalysis(track)?.key;
  if (!key) return 99;
  return parseInt(key.camelot) * 2 + (key.camelot.endsWith('B') ? 1 : 0);
}

function compareTracks(a: Track, b: Track, sort: SortOption): number {
  const dir = sort.direction === 'asc' ? 1 : -1;
  const text = (x: string, y: string) => x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true });
  const num = (x: number | undefined, y: number | undefined) => (x ?? Infinity) - (y ?? Infinity) || 0;
  switch (sort.field) {
    case 'title':
      return dir * text(titleOf(a), titleOf(b));
    case 'artist':
      return dir * (text(a.artist ?? '', b.artist ?? '') || text(titleOf(a), titleOf(b)));
    case 'bpm':
      return dir * num(bpmOf(a), bpmOf(b));
    case 'key':
      return dir * (keyOrder(a) - keyOrder(b));
    case 'duration':
      return dir * (a.duration - b.duration);
  }
}

function matches(track: Track, filter: FilterOptions): boolean {
  if (filter.searchQuery) {
    const query = filter.searchQuery.toLowerCase();
    const haystack = [track.title, track.artist, track.album, track.fileName].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  const bpm = bpmOf(track);
  if (bpm !== undefined) {
    if (filter.bpmMin !== undefined && bpm < filter.bpmMin) return false;
    if (filter.bpmMax !== undefined && bpm > filter.bpmMax) return false;
  }
  return true;
}

/**
 * Track browser: a tree of views on the left (collection, the automix queue, what has played)
 * and a sortable track list on the right. Rows load with a double-click or a drag onto a
 * deck; the hover buttons load, queue and set the reference track.
 */
export const Browser = memo(function Browser({
  tracks,
  queue,
  played,
  loaded,
  playing,
  sortOption,
  filterOptions,
  referenceTrackId,
  direction,
  autoEnabled,
  onImport,
  onSortChange,
  onFilterChange,
  onLoad,
  onToggleQueue,
  onMoveInQueue,
  onSetReference,
  onDirectionChange,
  onSmartOrder,
}: BrowserProps) {
  const [view, setView] = useState<View>('collection');
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const queued = useMemo(() => new Set(queue), [queue]);
  const playedSet = useMemo(() => new Set(played), [played]);
  const reference = referenceTrackId ? byId.get(referenceTrackId) ?? null : null;
  const referenceAnalysis = reference ? effectiveAnalysis(reference) : null;

  const rows = useMemo(() => {
    if (view === 'queue') return queue.flatMap((id) => byId.get(id) ?? []);
    if (view === 'history') return played.flatMap((id) => byId.get(id) ?? []);
    const shown = tracks.filter((t) => matches(t, filterOptions));
    if (referenceAnalysis) {
      const refBpm = referenceAnalysis.bpm;
      return [...shown].sort((a, b) => {
        const da = Math.abs((bpmOf(a) ?? Infinity) - refBpm);
        const db = Math.abs((bpmOf(b) ?? Infinity) - refBpm);
        if (da !== db) return da - db;
        const ka = effectiveAnalysis(a)?.key;
        const kb = effectiveAnalysis(b)?.key;
        return (kb ? harmonicScore(referenceAnalysis.key, kb) : 0) - (ka ? harmonicScore(referenceAnalysis.key, ka) : 0);
      });
    }
    return [...shown].sort((a, b) => compareTracks(a, b, sortOption));
  }, [view, queue, played, tracks, byId, filterOptions, referenceAnalysis, sortOption]);

  const sortBy = (field: SortOption['field']) => {
    if (view !== 'collection' || referenceAnalysis) return;
    const direction = sortOption.field === field && sortOption.direction === 'asc' ? 'desc' : 'asc';
    onSortChange({ field, direction });
  };

  /** Double-click loads the deck that isn't playing (deck A when both are idle). */
  const idleDeck: DeckId = playing.A && !playing.B ? 'B' : 'A';

  const onDragStart = (e: DragEvent<HTMLTableRowElement>, track: Track) => {
    e.dataTransfer.setData(TRACK_DRAG_TYPE, track.id);
    e.dataTransfer.setData('text/plain', titleOf(track));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const viewTitle = view === 'collection' ? 'Collection' : view === 'queue' ? 'Queue' : 'History';

  return (
    <div className="browser">
      <aside className="browser-side">
        <input
          type="search"
          className="browser-search"
          placeholder="Search"
          value={filterOptions.searchQuery || ''}
          onChange={(e) => {
            setView('collection');
            onFilterChange({ ...filterOptions, searchQuery: e.target.value });
          }}
        />
        <nav className="browser-tree">
          <button className={`tree-item ${view === 'collection' ? 'active' : ''}`} onClick={() => setView('collection')}>
            <span className="tree-icon">♫</span>
            <span>Collection</span>
            <span className="tree-count">{tracks.length}</span>
          </button>
          <button className={`tree-item ${view === 'queue' ? 'active' : ''}`} onClick={() => setView('queue')}>
            <span className="tree-icon">≡</span>
            <span>Queue</span>
            <span className="tree-count">{queue.length}</span>
          </button>
          <button className={`tree-item ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}>
            <span className="tree-icon">↺</span>
            <span>History</span>
            <span className="tree-count">{played.length}</span>
          </button>
        </nav>
        <button className="browser-import" onClick={onImport}>
          + Import tracks
        </button>
      </aside>

      <div className="browser-main">
        <div className="browser-toolbar">
          <span className="toolbar-title">{viewTitle}</span>
          <span className="toolbar-count">{rows.length}</span>
          {view === 'collection' && reference && (
            <button className="toolbar-chip" onClick={() => onSetReference(null)} title="Stop sorting by compatibility">
              ★ Sorted for {titleOf(reference)} ×
            </button>
          )}
          <span className="toolbar-spacer" />
          {view === 'collection' && (
            <span className="bpm-range" title="Show only tracks in this BPM range">
              <input
                type="number"
                placeholder="min"
                value={filterOptions.bpmMin ?? ''}
                onChange={(e) => onFilterChange({ ...filterOptions, bpmMin: e.target.value ? Number(e.target.value) : undefined })}
              />
              <span>–</span>
              <input
                type="number"
                placeholder="max"
                value={filterOptions.bpmMax ?? ''}
                onChange={(e) => onFilterChange({ ...filterOptions, bpmMax: e.target.value ? Number(e.target.value) : undefined })}
              />
              <span className="bpm-range-label">BPM</span>
            </span>
          )}
          {view === 'queue' && (
            <>
              <select
                className="toolbar-select"
                value={direction}
                onChange={(e) => onDirectionChange(e.target.value as TempoDirection)}
                title="Which way the set's tempo travels">
                <option value="up">Tempo up</option>
                <option value="down">Tempo down</option>
                <option value="any">Any tempo</option>
              </select>
              <button
                className="toolbar-btn"
                onClick={onSmartOrder}
                disabled={queue.length < 2}
                title="Order the queue for smooth tempo steps and compatible keys">
                Smart order
              </button>
            </>
          )}
        </div>

        <div className="browser-list">
          {rows.length === 0 ? (
            <div className="browser-empty">
              {view === 'collection' && tracks.length === 0 && 'No tracks yet. Import some audio files to get started.'}
              {view === 'collection' && tracks.length > 0 && 'Nothing matches.'}
              {view === 'queue' &&
                `Queue is empty. Add tracks with + in the collection.${autoEnabled ? ' Auto picks the best match from the collection when the queue is empty.' : ''}`}
              {view === 'history' && 'Nothing has played yet.'}
            </div>
          ) : (
            <table className="track-table">
              <colgroup>
                <col className="col-art" />
                <col className="col-num" />
                <col className="col-title" />
                <col className="col-artist" />
                <col className="col-bpm" />
                <col className="col-key" />
                <col className="col-time" />
                <col className="col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th />
                  <th className="cell-num">#</th>
                  {COLUMNS.map(({ field, label, className }) => {
                    const sortable = view === 'collection' && !referenceAnalysis;
                    const sorted = sortable && sortOption.field === field;
                    return (
                      <th
                        key={field}
                        className={`${className} ${sortable ? 'sortable' : ''} ${sorted ? 'sorted' : ''}`}
                        onClick={() => sortBy(field)}>
                        {label}
                        {sorted && <span className="sort-arrow">{sortOption.direction === 'asc' ? '▲' : '▼'}</span>}
                      </th>
                    );
                  })}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((track, index) => {
                  const analysis = effectiveAnalysis(track);
                  const bpm = analysis?.bpm;
                  const loadedOn = loaded.A === track.id ? 'A' : loaded.B === track.id ? 'B' : null;
                  const isReference = track.id === referenceTrackId;
                  const clash =
                    !!referenceAnalysis && !isReference && !!analysis?.key && harmonicScore(referenceAnalysis.key, analysis.key) < 0.5;
                  const bpmDiff = referenceAnalysis && bpm ? bpm - referenceAnalysis.bpm : null;
                  const classes = [
                    'row',
                    loadedOn ? `loaded-${loadedOn.toLowerCase()}` : '',
                    queued.has(track.id) ? 'queued' : '',
                    playedSet.has(track.id) && view !== 'history' ? 'played' : '',
                    isReference ? 'reference' : '',
                  ].join(' ');
                  return (
                    <tr
                      key={`${track.id}-${index}`}
                      className={classes}
                      draggable
                      onDragStart={(e) => onDragStart(e, track)}
                      onDoubleClick={() => onLoad(idleDeck, track)}>
                      <td className="cell-art">
                        {track.artwork ? <img src={track.artwork} alt="" className="row-art" /> : <span className="row-art row-art-empty" />}
                      </td>
                      <td className="cell-num">
                        {loadedOn ? <span className={`deck-tag deck-tag-${loadedOn.toLowerCase()}`}>{loadedOn}</span> : index + 1}
                      </td>
                      <td className="cell-title">
                        <span className="row-title">{titleOf(track)}</span>
                      </td>
                      <td className="cell-artist">{track.artist ?? ''}</td>
                      <td className="cell-bpm">
                        {track.analysisStatus === 'pending' && <span className="bpm-pending">…</span>}
                        {track.analysisStatus === 'analyzing' && <span className="spinner" title="Analysing" />}
                        {track.analysisStatus === 'error' && <span className="bpm-error">err</span>}
                        {track.analysisStatus === 'complete' && bpm && (
                          <>
                            {bpm.toFixed(1)}
                            {track.overrides?.tempoMultiplier && <span title="Tempo octave corrected by hand">*</span>}
                            {bpmDiff !== null && (
                              <span className={`bpm-diff ${Math.abs(bpmDiff) < 1 ? 'match' : ''}`}>
                                {bpmDiff > 0 ? '+' : ''}
                                {bpmDiff.toFixed(1)}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="cell-key">{analysis?.key && <KeyBadge trackKey={analysis.key} dimmed={clash} />}</td>
                      <td className="cell-time">{formatTime(track.duration)}</td>
                      <td className="cell-actions">
                        {view === 'queue' ? (
                          <>
                            <button className="row-btn" onClick={() => onMoveInQueue(track.id, -1)} disabled={index === 0} title="Move up">
                              ↑
                            </button>
                            <button
                              className="row-btn"
                              onClick={() => onMoveInQueue(track.id, 1)}
                              disabled={index === rows.length - 1}
                              title="Move down">
                              ↓
                            </button>
                            <button className="row-btn" onClick={() => onToggleQueue(track.id)} title="Remove from the queue">
                              ×
                            </button>
                          </>
                        ) : (
                          <>
                            <button className="row-btn row-btn-a" onClick={() => onLoad('A', track)} title="Load on deck A">
                              A
                            </button>
                            <button className="row-btn row-btn-b" onClick={() => onLoad('B', track)} title="Load on deck B">
                              B
                            </button>
                            <button
                              className={`row-btn ${queued.has(track.id) ? 'on' : ''}`}
                              onClick={() => onToggleQueue(track.id)}
                              title={queued.has(track.id) ? 'Remove from the queue' : 'Add to the queue'}>
                              {queued.has(track.id) ? '✓' : '+'}
                            </button>
                            <button
                              className={`row-btn ${isReference ? 'on' : ''}`}
                              onClick={() => onSetReference(isReference ? null : track.id)}
                              title="Sort the collection by compatibility with this track">
                              {isReference ? '★' : '☆'}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
});
