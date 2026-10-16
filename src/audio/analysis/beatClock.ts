import type { GridAnchor } from './types';

/** Maps beat indices to track time and back. */
export interface BeatClock {
  timeOf(beat: number): number;
  beatAt(time: number): number;
}

export function constantClock(beatTime: number, period: number): BeatClock {
  return {
    timeOf: (beat) => beatTime + beat * period,
    beatAt: (time) => (time - beatTime) / period,
  };
}

/**
 * Piecewise-linear clock through measured beat positions, for tracks whose tempo drifts.
 * Beyond the first and last anchor it continues at the local tempo there (`period` when
 * there is only one anchor).
 */
export function anchoredClock(anchors: GridAnchor[], period: number): BeatClock {
  const points = [...anchors].sort((a, b) => a.beat - b.beat);
  const first = points[0];
  const last = points[points.length - 1];
  const slope = (a: GridAnchor, b: GridAnchor) => (b.time - a.time) / (b.beat - a.beat);
  const startPeriod = points.length > 1 ? slope(points[0], points[1]) : period;
  const endPeriod = points.length > 1 ? slope(points[points.length - 2], last) : period;

  const segment = <K extends 'beat' | 'time'>(key: K, value: number): number => {
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid][key] <= value) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  return {
    timeOf(beat) {
      if (beat <= first.beat) return first.time + (beat - first.beat) * startPeriod;
      if (beat >= last.beat) return last.time + (beat - last.beat) * endPeriod;
      const i = segment('beat', beat);
      const a = points[i];
      const b = points[i + 1];
      return a.time + ((beat - a.beat) * (b.time - a.time)) / (b.beat - a.beat);
    },
    beatAt(time) {
      if (time <= first.time) return first.beat + (time - first.time) / startPeriod;
      if (time >= last.time) return last.beat + (time - last.time) / endPeriod;
      const i = segment('time', time);
      const a = points[i];
      const b = points[i + 1];
      return a.beat + ((time - a.time) * (b.beat - a.beat)) / (b.time - a.time);
    },
  };
}
