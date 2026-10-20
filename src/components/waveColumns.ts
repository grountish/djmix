/**
 * One pixel column of a zoomed waveform. Columns sit on a fixed grid of track time: column `k`
 * covers [k, k + 1) / pxPerSecond seconds, whatever the view, so a scrolling view slides the
 * same columns along instead of resampling them (which makes peaks grow and shrink from frame
 * to frame: a shimmer).
 */
export interface WaveColumn {
  /** 0–1. */
  amplitude: number;
  /** The bin the column's colour comes from. */
  bin: number;
}

/**
 * `data` holds one level per bin, the bins spread evenly over `duration` seconds. A column
 * spanning half a bin or more shows the peak of the bins it touches (interpolating there would
 * flatten peaks that fall between column centres); a bin spanning several columns is
 * interpolated between bin centres.
 */
export function waveColumn(data: ArrayLike<number>, duration: number, pxPerSecond: number, k: number): WaveColumn {
  const binsPerSecond = data.length / duration;
  const from = (k / pxPerSecond) * binsPerSecond;
  const to = ((k + 1) / pxPerSecond) * binsPerSecond;
  const level = (i: number) => (i >= 0 && i < data.length ? data[i] || 0 : 0);
  if (to - from >= 0.5) {
    let bin = Math.floor(from);
    let amplitude = 0;
    for (let i = Math.floor(from); i < Math.ceil(to); i++) {
      if (level(i) > amplitude) {
        amplitude = level(i);
        bin = i;
      }
    }
    return { amplitude, bin };
  }
  const pos = (from + to) / 2 - 0.5;
  const i = Math.floor(pos);
  const frac = pos - i;
  return { amplitude: level(i) * (1 - frac) + level(i + 1) * frac, bin: Math.min(data.length - 1, Math.max(0, Math.round(pos))) };
}
