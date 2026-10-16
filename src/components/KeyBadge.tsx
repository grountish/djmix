import type { TrackKey } from '@/types';

/** Camelot key in its wheel colour: neighbouring (compatible) keys get neighbouring hues. */
export function KeyBadge({ trackKey, dimmed = false }: { trackKey: TrackKey; dimmed?: boolean }) {
  const hue = (parseInt(trackKey.camelot) - 1) * 30;
  const title =
    trackKey.source === 'tag'
      ? 'Key from the file tag'
      : `Detected key (confidence ${Math.round(trackKey.confidence * 100)}%)`;
  return (
    <span
      className={`key-badge ${dimmed ? 'dimmed' : ''} ${trackKey.source === 'audio' ? 'detected' : ''}`}
      style={{ color: `hsl(${hue}, 65%, 62%)` }}
      title={title}>
      {trackKey.camelot}
    </span>
  );
}
