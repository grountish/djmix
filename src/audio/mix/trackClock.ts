import { anchoredClock, type BeatClock, constantClock } from '../analysis/beatClock';
import type { AudioAnalysis } from '../analysis/types';

/**
 * Beat clock of an analysed track, beat 0 being the first downbeat. Drifting tracks follow
 * their measured beats; `bpm` overrides the analysed tempo (a manual correction).
 */
export function trackClock(analysis: AudioAnalysis, bpm: number = analysis.bpm): BeatClock {
  const period = 60 / bpm;
  const anchors = analysis.tempo.anchors;
  return anchors && anchors.length >= 2 && bpm === analysis.bpm
    ? anchoredClock(anchors, period)
    : constantClock(analysis.firstBeatTime, period);
}
