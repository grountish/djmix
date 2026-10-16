import { effectiveAnalysis } from '@/audio/analysis/overrides';
import type { TempoDirection } from '@/audio/mix/sequencer';
import type { Track } from '@/types';
import { KeyBadge } from './KeyBadge';

interface QueuePanelProps {
  tracks: Track[];
  direction: TempoDirection;
  autoEnabled: boolean;
  onDirectionChange: (direction: TempoDirection) => void;
  onSmartOrder: () => void;
  onMove: (trackId: string, offset: number) => void;
  onRemove: (trackId: string) => void;
}

export function QueuePanel({
  tracks,
  direction,
  autoEnabled,
  onDirectionChange,
  onSmartOrder,
  onMove,
  onRemove,
}: QueuePanelProps) {
  return (
    <div className="queue-panel">
      <div className="queue-header">
        <span className="queue-title">Queue ({tracks.length})</span>
        <select
          className="queue-direction"
          value={direction}
          onChange={(e) => onDirectionChange(e.target.value as TempoDirection)}
          title="Which way the set's tempo travels">
          <option value="up">Tempo up</option>
          <option value="down">Tempo down</option>
          <option value="any">Any tempo</option>
        </select>
        <button
          className="mode-button"
          onClick={onSmartOrder}
          disabled={tracks.length < 2}
          title="Order the queue for smooth tempo steps and compatible keys">
          Smart order
        </button>
      </div>
      {tracks.length === 0 ? (
        <div className="queue-empty">
          Add tracks with + in the library.
          {autoEnabled && ' With Auto on and an empty queue, the best match from the library plays next.'}
        </div>
      ) : (
        <ol className="queue-list">
          {tracks.map((track, index) => {
            const analysis = effectiveAnalysis(track);
            return (
              <li key={track.id} className="queue-item">
                <span className="queue-index">{index + 1}</span>
                <span className="queue-name" title={track.fileName}>
                  {track.title || track.fileName}
                </span>
                <span className="queue-bpm">{analysis ? analysis.bpm.toFixed(1) : '…'}</span>
                {analysis?.key && <KeyBadge trackKey={analysis.key} />}
                <button className="track-action-button" onClick={() => onMove(track.id, -1)} disabled={index === 0} title="Move up">
                  ↑
                </button>
                <button
                  className="track-action-button"
                  onClick={() => onMove(track.id, 1)}
                  disabled={index === tracks.length - 1}
                  title="Move down">
                  ↓
                </button>
                <button className="track-action-button" onClick={() => onRemove(track.id)} title="Remove from queue">
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
