import type { BeatClock } from '../analysis/beatClock';
import type { Phrase } from '../analysis/types';
import { BEATS_PER_BAR, ctxTimeAt, type PlayheadAnchor, trackTimeAt } from './transport';

/**
 * - tempo: match the tempo only (the rate), the phase is left alone.
 * - beat: also land on the master's beats.
 * - bar: beats and the bar line (downbeat on downbeat).
 * - phrase: bars, and the phrases change together: the same number of bars to go until the
 *   next phrase, so a drop lands with a drop.
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

interface PhraseSpan {
  start: number;
  bars: number;
}

/**
 * The phrase containing `bar`: an analysed one, or a cell of the regular grid before, after
 * and without the analysed phrases.
 */
export function phraseAt(bar: number, phrases: Phrase[] | undefined): PhraseSpan {
  const spans = phraseSpans(phrases);
  for (const span of spans) {
    if (bar >= span.start && bar < span.start + span.bars) return span;
  }
  const origin = spans.length === 0 ? 0 : bar < spans[0].start ? 0 : spans[spans.length - 1].start + spans[spans.length - 1].bars;
  const start = origin + Math.floor((bar - origin) / DEFAULT_PHRASE_BARS) * DEFAULT_PHRASE_BARS;
  return { start, bars: DEFAULT_PHRASE_BARS };
}

/** Bar where the phrase containing `bar` starts. */
export function phraseStartBar(bar: number, phrases: Phrase[] | undefined): number {
  return phraseAt(bar, phrases).start;
}

function phraseSpans(phrases: Phrase[] | undefined): PhraseSpan[] {
  if (!phrases || phrases.length === 0) return [];
  return [...phrases].map((p) => ({ start: p.startBar, bars: p.bars })).sort((a, b) => a.start - b.start);
}

/**
 * The follower's track time that, at audio-clock time `at`, puts it in phase with the master
 * under `mode`, moving it by the shortest distance. 'tempo' leaves it where it is. A position
 * before the track's start (a follower parked at 0) moves forward to the next one in phase.
 */
export function phaseSyncTarget(mode: SyncMode, master: SyncMaster, follower: SyncFollower, at: number): number {
  if (mode === 'tempo') return follower.trackTime;
  const masterBeat = master.clock.beatAt(trackTimeAt(master.anchor, at));
  const followerBeat = follower.clock.beatAt(follower.trackTime);

  let targetBeat: number;
  let unit: number;
  if (mode === 'phrase') {
    const masterBar = masterBeat / BEATS_PER_BAR;
    const masterPhrase = phraseAt(masterBar, master.phrases);
    const followerBar = followerBeat / BEATS_PER_BAR;
    targetBeat = nearestPhrasePosition(followerBar, masterBar - masterPhrase.start, masterPhrase.start + masterPhrase.bars - masterBar, follower.phrases) * BEATS_PER_BAR;
    unit = DEFAULT_PHRASE_BARS * BEATS_PER_BAR;
  } else {
    unit = mode === 'bar' ? BEATS_PER_BAR : 1;
    targetBeat = followerBeat + nearestPhaseDelta(masterBeat - followerBeat, unit);
  }
  let guard = 0;
  while (follower.clock.timeOf(targetBeat) < 0 && guard++ < 1024) targetBeat += unit;
  return follower.clock.timeOf(targetBeat);
}

/**
 * The position nearest `bar` in one of the follower's phrases with `remaining` bars to go to
 * its end (the phrases then change together). When no phrase is that long, the position
 * `offset` bars into the nearest phrase instead.
 */
function nearestPhrasePosition(bar: number, offset: number, remaining: number, phrases: Phrase[] | undefined): number {
  const spans = phraseSpans(phrases);
  // The regular grid runs before and after the analysed phrases, so every position can sync.
  const candidates: PhraseSpan[] = [...spans];
  const reach = DEFAULT_PHRASE_BARS * 2 + Math.max(offset, remaining);
  const after = spans.length === 0 ? 0 : spans[spans.length - 1].start + spans[spans.length - 1].bars;
  for (let s = after; s <= bar + reach; s += DEFAULT_PHRASE_BARS) candidates.push({ start: s, bars: DEFAULT_PHRASE_BARS });
  const before = spans.length === 0 ? 0 : spans[0].start;
  for (let s = before - DEFAULT_PHRASE_BARS; s >= bar - reach; s -= DEFAULT_PHRASE_BARS) {
    candidates.push({ start: s, bars: DEFAULT_PHRASE_BARS });
  }
  const nearest = (positions: number[]): number =>
    positions.reduce((best, p) => (Math.abs(p - bar) < Math.abs(best - bar) ? p : best));
  const endAligned = candidates.filter((c) => c.bars >= remaining).map((c) => c.start + c.bars - remaining);
  if (endAligned.length > 0) return nearest(endAligned);
  return nearest(candidates.map((c) => c.start + offset));
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
