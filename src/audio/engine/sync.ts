import type { BeatClock } from '../analysis/beatClock';
import type { Phrase } from '../analysis/types';
import { BEATS_PER_BAR, ctxTimeAt, type PlayheadAnchor, trackTimeAt } from './transport';

/**
 * - tempo: match the tempo only (the rate), the phase is left alone.
 * - beat: also land on the master's beats.
 * - bar: beats and the bar line (downbeat on downbeat).
 * - phrase: bars, and the same distance into the phrase, so drops line up.
 */
export type SyncMode = 'tempo' | 'beat' | 'bar' | 'phrase';

export const SYNC_MODES: { mode: SyncMode; label: string }[] = [
  { mode: 'tempo', label: 'Tempo' },
  { mode: 'beat', label: 'Beat' },
  { mode: 'bar', label: 'Bar' },
  { mode: 'phrase', label: 'Phrase' },
];

/** Bars per phrase when a track has no analysed phrases. */
export const DEFAULT_PHRASE_BARS = 16;

/** The deck being followed; it is playing. Beat 0 of its clock is its first downbeat. */
export interface SyncMaster {
  clock: BeatClock;
  anchor: PlayheadAnchor;
  phrases?: Phrase[];
}

/** The deck being moved: where it is (or would be) at the moment of the move. */
export interface SyncFollower {
  clock: BeatClock;
  trackTime: number;
  phrases?: Phrase[];
}

/** Wraps `delta` into (-unit/2, unit/2]: the shortest move onto the same phase. */
export function nearestPhaseDelta(delta: number, unit: number): number {
  let d = delta % unit;
  if (d > unit / 2) d -= unit;
  if (d <= -unit / 2) d += unit;
  return d;
}

/** Bar where the phrase containing `bar` starts (a regular grid without analysed phrases). */
export function phraseStartBar(bar: number, phrases: Phrase[] | undefined): number {
  const starts = phraseStarts(phrases);
  if (starts.length === 0) return Math.floor(bar / DEFAULT_PHRASE_BARS) * DEFAULT_PHRASE_BARS;
  let start = starts[0];
  for (const s of starts) if (s <= bar) start = s;
  if (bar < starts[0]) return Math.floor(bar / DEFAULT_PHRASE_BARS) * DEFAULT_PHRASE_BARS;
  const last = phrases![phrases!.length - 1];
  const end = last.startBar + last.bars;
  if (bar >= end) return end + Math.floor((bar - end) / DEFAULT_PHRASE_BARS) * DEFAULT_PHRASE_BARS;
  return start;
}

function phraseStarts(phrases: Phrase[] | undefined): number[] {
  if (!phrases || phrases.length === 0) return [];
  return [...phrases].map((p) => p.startBar).sort((a, b) => a - b);
}

/**
 * The follower's track time that, at audio-clock time `at`, puts it in phase with the master
 * under `mode`, moving it by the shortest distance. 'tempo' leaves it where it is.
 */
export function phaseSyncTarget(mode: SyncMode, master: SyncMaster, follower: SyncFollower, at: number): number {
  if (mode === 'tempo') return follower.trackTime;
  const masterBeat = master.clock.beatAt(trackTimeAt(master.anchor, at));
  const followerBeat = follower.clock.beatAt(follower.trackTime);

  if (mode === 'phrase') {
    const masterBar = masterBeat / BEATS_PER_BAR;
    const offset = masterBar - phraseStartBar(masterBar, master.phrases);
    const followerBar = followerBeat / BEATS_PER_BAR;
    const targetBar = nearestPhrasePosition(followerBar, offset, follower.phrases);
    return follower.clock.timeOf(targetBar * BEATS_PER_BAR);
  }

  const unit = mode === 'bar' ? BEATS_PER_BAR : 1;
  const delta = nearestPhaseDelta(masterBeat - followerBeat, unit);
  return follower.clock.timeOf(followerBeat + delta);
}

/** The bar `offset` bars into whichever of the follower's phrases lies nearest `bar`. */
function nearestPhrasePosition(bar: number, offset: number, phrases: Phrase[] | undefined): number {
  const starts = phraseStarts(phrases);
  if (starts.length === 0) {
    const base = Math.round((bar - offset) / DEFAULT_PHRASE_BARS) * DEFAULT_PHRASE_BARS;
    return base + offset;
  }
  const last = phrases![phrases!.length - 1];
  const end = last.startBar + last.bars;
  // Keep a regular grid running past the analysed phrases, so late positions still sync.
  const candidates = [...starts];
  for (let s = end; s <= bar + DEFAULT_PHRASE_BARS; s += DEFAULT_PHRASE_BARS) candidates.push(s);
  for (let s = starts[0] - DEFAULT_PHRASE_BARS; s >= bar - offset - DEFAULT_PHRASE_BARS; s -= DEFAULT_PHRASE_BARS) {
    candidates.push(s);
  }
  let best = candidates[0];
  for (const s of candidates) {
    if (Math.abs(s + offset - bar) < Math.abs(best + offset - bar)) best = s;
  }
  return best + offset;
}

/** Beats per unit a follower starts on: a beat for beat sync, a bar line otherwise. */
export function syncStartUnit(mode: SyncMode): number {
  return mode === 'beat' ? 1 : BEATS_PER_BAR;
}

/**
 * The master's next unit boundary (every `unitBeats` beats from its first downbeat) at least
 * `minLead` seconds after `now` on the audio clock: when a stopped follower should start.
 */
export function nextUnitOnClock(
  master: SyncMaster,
  unitBeats: number,
  now: number,
  minLead: number,
): { ctxTime: number; trackTime: number } {
  const earliest = now + minLead;
  const beatNow = master.clock.beatAt(trackTimeAt(master.anchor, earliest));
  let beat = Math.ceil(beatNow / unitBeats - 1e-9) * unitBeats;
  let trackTime = master.clock.timeOf(beat);
  while (ctxTimeAt(master.anchor, trackTime) < earliest) {
    beat += unitBeats;
    trackTime = master.clock.timeOf(beat);
  }
  return { ctxTime: ctxTimeAt(master.anchor, trackTime), trackTime };
}
