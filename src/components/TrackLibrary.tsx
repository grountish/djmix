import type { Track, SortOption, FilterOptions } from '@/types';

interface TrackLibraryProps {
  tracks: Track[];
  sortOption: SortOption;
  filterOptions: FilterOptions;
  referenceTrackId: string | null;
  onImport: () => void;
  onSortChange: (sort: SortOption) => void;
  onFilterChange: (filter: FilterOptions) => void;
  onLoadToDeckA: (track: Track) => void;
  onLoadToDeckB: (track: Track) => void;
  onSetReference: (trackId: string | null) => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function sortTracks(tracks: Track[], sort: SortOption): Track[] {
  const sorted = [...tracks].sort((a, b) => {
    let aVal: string | number;
    let bVal: string | number;

    switch (sort.field) {
      case 'bpm':
        aVal = a.analysis?.manualBpm || a.analysis?.bpm || 0;
        bVal = b.analysis?.manualBpm || b.analysis?.bpm || 0;
        break;
      case 'duration':
        aVal = a.duration;
        bVal = b.duration;
        break;
      default:
        aVal = a.fileName.toLowerCase();
        bVal = b.fileName.toLowerCase();
    }

    if (aVal < bVal) return sort.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return sort.direction === 'asc' ? 1 : -1;
    return 0;
  });

  return sorted;
}

function filterTracks(tracks: Track[], filter: FilterOptions): Track[] {
  return tracks.filter((track) => {
    if (filter.searchQuery) {
      const query = filter.searchQuery.toLowerCase();
      if (!track.fileName.toLowerCase().includes(query)) {
        return false;
      }
    }

    const bpm = track.analysis?.manualBpm || track.analysis?.bpm;
    if (filter.bpmMin !== undefined && bpm !== undefined && bpm < filter.bpmMin) {
      return false;
    }
    if (filter.bpmMax !== undefined && bpm !== undefined && bpm > filter.bpmMax) {
      return false;
    }

    return true;
  });
}

function sortByBpmSimilarity(tracks: Track[], referenceBpm: number): Track[] {
  return [...tracks].sort((a, b) => {
    const aBpm = a.analysis?.manualBpm || a.analysis?.bpm || 0;
    const bBpm = b.analysis?.manualBpm || b.analysis?.bpm || 0;
    const aDiff = Math.abs(aBpm - referenceBpm);
    const bDiff = Math.abs(bBpm - referenceBpm);
    return aDiff - bDiff;
  });
}

export function TrackLibrary({
  tracks,
  sortOption,
  filterOptions,
  referenceTrackId,
  onImport,
  onSortChange,
  onFilterChange,
  onLoadToDeckA,
  onLoadToDeckB,
  onSetReference,
}: TrackLibraryProps) {
  const referenceTrack = referenceTrackId ? tracks.find((t) => t.id === referenceTrackId) : null;
  const referenceBpm = referenceTrack?.analysis?.manualBpm || referenceTrack?.analysis?.bpm;

  let displayTracks = filterTracks(tracks, filterOptions);

  if (referenceBpm) {
    displayTracks = sortByBpmSimilarity(displayTracks, referenceBpm);
  } else {
    displayTracks = sortTracks(displayTracks, sortOption);
  }

  const handleSortChange = (value: string) => {
    const [field, direction] = value.split('-') as [SortOption['field'], SortOption['direction']];
    onSortChange({ field, direction });
  };

  return (
    <div className="library-sidebar">
      <div className="library-header">
        <div className="library-title">Library ({tracks.length} tracks)</div>
        <button className="import-button" onClick={onImport}>
          Import Tracks
        </button>

        <div className="library-filters">
          <input
            type="text"
            className="search-input"
            placeholder="Search..."
            value={filterOptions.searchQuery || ''}
            onChange={(e) => onFilterChange({ ...filterOptions, searchQuery: e.target.value })}
          />

          <div className="bpm-filter">
            <input
              type="number"
              placeholder="Min"
              value={filterOptions.bpmMin || ''}
              onChange={(e) =>
                onFilterChange({
                  ...filterOptions,
                  bpmMin: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
            <span>-</span>
            <input
              type="number"
              placeholder="Max"
              value={filterOptions.bpmMax || ''}
              onChange={(e) =>
                onFilterChange({
                  ...filterOptions,
                  bpmMax: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
            <span>BPM</span>
          </div>

          <select
            className="sort-select"
            value={`${sortOption.field}-${sortOption.direction}`}
            onChange={(e) => handleSortChange(e.target.value)}
            disabled={!!referenceBpm}>
            <option value="fileName-asc">Name (A-Z)</option>
            <option value="fileName-desc">Name (Z-A)</option>
            <option value="bpm-asc">BPM (Low-High)</option>
            <option value="bpm-desc">BPM (High-Low)</option>
            <option value="duration-asc">Duration (Short)</option>
            <option value="duration-desc">Duration (Long)</option>
          </select>

          {referenceTrack && (
            <button onClick={() => onSetReference(null)}>
              Clear Reference ({referenceTrack.fileName.slice(0, 15)}...)
            </button>
          )}
        </div>
      </div>

      <div className="library-list">
        {displayTracks.length === 0 ? (
          <div className="empty-library">
            {tracks.length === 0 ? (
              <>
                <p>No tracks imported</p>
                <p>Click "Import Tracks" to add audio files</p>
              </>
            ) : (
              <p>No tracks match filters</p>
            )}
          </div>
        ) : (
          <table className="track-table">
            <thead>
              <tr>
                <th className="th-name">Name</th>
                <th className="th-bpm">BPM</th>
                <th className="th-duration">Duration</th>
                <th className="th-load">Load</th>
              </tr>
            </thead>
            <tbody>
              {displayTracks.map((track) => {
                const bpm = track.analysis?.manualBpm || track.analysis?.bpm;
                const bpmDiff = referenceBpm && bpm ? Math.abs(bpm - referenceBpm) : null;

                return (
                  <tr
                    key={track.id}
                    className={`track-row ${track.id === referenceTrackId ? 'reference' : ''}`}>
                    <td className="td-name">
                      <span className="track-name">{track.fileName}</span>
                      {bpmDiff !== null && (
                        <span className="similarity-badge">
                          {bpmDiff < 1 ? 'Match' : `±${bpmDiff.toFixed(1)}`}
                        </span>
                      )}
                    </td>
                    <td className="td-bpm">
                      <span
                        className={`track-bpm ${track.analysisStatus === 'pending' ? 'pending' : ''} ${
                          track.analysisStatus === 'analyzing' ? 'analyzing' : ''
                        } ${track.analysisStatus === 'error' ? 'error' : ''}`}>
                        {track.analysisStatus === 'pending' && '...'}
                        {track.analysisStatus === 'analyzing' && (
                          <>
                            <span className="loading-spinner" />
                          </>
                        )}
                        {track.analysisStatus === 'error' && 'Err'}
                        {track.analysisStatus === 'complete' && bpm && (
                          <>
                            {bpm.toFixed(1)}
                            {track.analysis?.manualBpm && '*'}
                          </>
                        )}
                      </span>
                    </td>
                    <td className="td-duration">{formatDuration(track.duration)}</td>
                    <td className="td-load">
                      <button className="track-action-button" onClick={() => onLoadToDeckA(track)}>
                        A
                      </button>
                      <button className="track-action-button" onClick={() => onLoadToDeckB(track)}>
                        B
                      </button>
                      <button
                        className="track-action-button ref-button"
                        onClick={() =>
                          onSetReference(track.id === referenceTrackId ? null : track.id)
                        }>
                        {track.id === referenceTrackId ? '★' : '☆'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
