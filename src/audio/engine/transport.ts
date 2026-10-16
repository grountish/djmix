/**
 * Maps the audio clock to a deck's position in its track: from `ctxTime` on, the playhead
 * advances from `trackTime` at `rate` track-seconds per clock-second.
 */
export interface PlayheadAnchor {
  ctxTime: number;
  trackTime: number;
  rate: number;
}

/** Constant-tempo beat grid in track time. */
export interface BeatGrid {
  bpm: number;
  firstBeatTime: number;
}

export const BEATS_PER_BAR = 4;

/** Web Audio renders in blocks of this many frames; k-rate params change only on block edges. */
export const RENDER_QUANTUM_FRAMES = 128;

/**
 * How far ahead timing-critical changes are scheduled. The audio thread renders ahead of
 * `currentTime`, so a change "now" lands a block or more late; scheduling past that window
 * makes the audio match the playhead math exactly.
 */
export const SCHEDULE_LEAD = 0.04;

/** First render-quantum edge at or after `time`. */
export function alignToRenderQuantum(time: number, sampleRate: number): number {
  const quanta = Math.ceil((time * sampleRate) / RENDER_QUANTUM_FRAMES - 1e-9);
  return (quanta * RENDER_QUANTUM_FRAMES) / sampleRate;
}

export function trackTimeAt(anchor: PlayheadAnchor, ctxTime: number): number {
  // Before a scheduled start the playhead waits at its start offset.
  if (ctxTime <= anchor.ctxTime) return anchor.trackTime;
  return anchor.trackTime + (ctxTime - anchor.ctxTime) * anchor.rate;
}

export function ctxTimeAt(anchor: PlayheadAnchor, trackTime: number): number {
  return anchor.ctxTime + (trackTime - anchor.trackTime) / anchor.rate;
}

/** Re-anchors at `ctxTime` with a new rate, keeping the playhead continuous. */
export function rebaseAnchor(
  anchor: PlayheadAnchor,
  ctxTime: number,
  rate: number,
): PlayheadAnchor {
  if (ctxTime <= anchor.ctxTime) return { ...anchor, rate };
  return { ctxTime, trackTime: trackTimeAt(anchor, ctxTime), rate };
}

export function barDuration(grid: BeatGrid): number {
  return (60 / grid.bpm) * BEATS_PER_BAR;
}

/** First bar line strictly after `trackTime`. Bar lines extend before the first beat too. */
export function nextBarTime(grid: BeatGrid, trackTime: number): number {
  const bar = barDuration(grid);
  const barIndex = Math.floor((trackTime - grid.firstBeatTime) / bar) + 1;
  return grid.firstBeatTime + barIndex * bar;
}

/**
 * First bar line of a running deck that falls at least `minLead` seconds after `now` on the
 * audio clock, so another deck can be started exactly on it.
 */
export function nextBarOnClock(
  anchor: PlayheadAnchor,
  grid: BeatGrid,
  now: number,
  minLead: number,
): { trackTime: number; ctxTime: number } {
  const bar = barDuration(grid);
  let trackTime = nextBarTime(grid, trackTimeAt(anchor, now));
  while (ctxTimeAt(anchor, trackTime) < now + minLead) {
    trackTime += bar;
  }
  return { trackTime, ctxTime: ctxTimeAt(anchor, trackTime) };
}
