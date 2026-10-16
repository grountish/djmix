import type { TrackKey } from '@/types';

const TITLES: Record<TrackKey['source'], (key: TrackKey) => string> = {
  tag: () => 'Key from the file tag',
  audio: (key) => `Detected key (confidence ${Math.round(key.confidence * 100)}%)`,
  manual: () => 'Key set by hand',
};

/** Camelot key in its wheel colour: neighbouring (compatible) keys get neighbouring hues. */
export function KeyBadge({ trackKey, dimmed = false }: { trackKey: TrackKey; dimmed?: boolean }) {
  const hue = (parseInt(trackKey.camelot) - 1) * 30;
  const source = trackKey.source === 'audio' ? 'detected' : trackKey.source === 'manual' ? 'manual' : '';
  return (
    <span
      className={`key-badge ${dimmed ? 'dimmed' : ''} ${source}`}
      style={{ color: `hsl(${hue}, 65%, 62%)` }}
      title={TITLES[trackKey.source](trackKey)}>
      {trackKey.camelot}
    </span>
  );
}
