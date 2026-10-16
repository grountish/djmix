import type { Phrase } from '../analysis/types';

const PHRASE_BARS = 8;
const OVERLAP_CHOICES = [32, 16, 8];

export interface MixPointTrack {
  phrases: Phrase[];
  /** Full bars from the first downbeat. */
  barCount: number;
}

export interface MixPointInput {
  outgoing: MixPointTrack & {
    /** Bar the outgoing track has reached (fractional). */
    currentBar: number;
  };
  incoming: MixPointTrack;
  /** Bars the outgoing track needs before the overlap starts (tempo ramp, scheduling). */
  leadBars: number;
  maxOverlapBars: number;
  /**
   * 'end': mix where the outgoing track runs out (Auto). 'now': at the next 16/32-bar entry
   * that can be reached (Mix now).
   */
  timing?: MixTiming;
}

export type MixTiming = 'now' | 'end';

/** Mix-now entries sit on this lattice of the phrase grid (or on a section start). */
const ENTRY_BARS = 16;

export interface MixPoints {
  /** 0 means no overlap: a cut on the phrase line. */
  overlapBars: number;
  /** Bar of the outgoing track where the incoming track comes in. */
  outgoingStartBar: number;
  /** Bar of the incoming track that plays at that moment. */
  incomingStartBar: number;
  /** Bar of the overlap (0-based) where the basslines swap, on a downbeat. */
  bassSwapBar: number;
}

/** Offset of the 8-bar phrase grid: phrases start on it (bar 0 aside). */
export function phraseOrigin(phrases: Phrase[]): number {
  const first = phrases.find((p) => p.startBar > 0);
  return first ? first.startBar % PHRASE_BARS : 0;
}

function onGrid(bar: number, origin: number): boolean {
  return (((bar - origin) % PHRASE_BARS) + PHRASE_BARS) % PHRASE_BARS === 0;
}

/** First bar of the incoming track's main section: where its intro ends. */
export function firstDropBar(phrases: Phrase[]): number {
  return phrases.find((p) => p.label === 'drop')?.startBar ?? 0;
}

/** Without at least this much intro, the incoming track starts in its main section: keep it short. */
const MIN_INTRO_FOR_LONG_BLEND = 8;
const SHORT_BLEND_BARS = 16;

/**
 * Where to mix. Both tracks change on their phrase grids at the same moment: the overlap ends
 * where the outgoing track runs out, as late as possible. The incoming intro is placed so its
 * first drop lands at the end of the overlap; when the intro is shorter than the overlap the
 * incoming track starts from its top and the basslines swap on its drop, so it hits with its
 * bass as the outgoing bass leaves.
 */
export function chooseMixPoints(input: MixPointInput): MixPoints {
  const { outgoing, incoming } = input;
  const originOut = phraseOrigin(outgoing.phrases);
  const originIn = phraseOrigin(incoming.phrases);
  const intro = firstDropBar(incoming.phrases);
  const earliest = Math.ceil(outgoing.currentBar + input.leadBars);
  const longest = intro >= MIN_INTRO_FOR_LONG_BLEND ? input.maxOverlapBars : Math.min(input.maxOverlapBars, SHORT_BLEND_BARS);

  const entries = input.timing === 'now' ? entryBars(outgoing.phrases, outgoing.barCount, originOut) : [];

  for (const overlap of OVERLAP_CHOICES) {
    if (overlap > longest) continue;

    let start: number;
    if (input.timing === 'now') {
      const entry = entries.find((bar) => bar >= earliest && bar + overlap <= outgoing.barCount);
      if (entry === undefined) continue;
      start = entry;
    } else {
      start = outgoing.barCount - overlap;
      while (start >= earliest && !onGrid(start, originOut)) start--;
      if (start < earliest) continue;
    }

    let incomingStart = Math.max(0, intro - overlap);
    while (incomingStart > 0 && !onGrid(incomingStart, originIn)) incomingStart--;

    return {
      overlapBars: overlap,
      outgoingStartBar: start,
      incomingStartBar: incomingStart,
      bassSwapBar: bassSwapBar(overlap, intro - incomingStart),
    };
  }

  // No blend: cut straight into the incoming track's main section so the energy carries on —
  // at the next entry for 'now', else on the last phrase line before the final phrase.
  if (input.timing === 'now') {
    const entry = entries.find((bar) => bar >= earliest && bar < outgoing.barCount);
    if (entry !== undefined) return { overlapBars: 0, outgoingStartBar: entry, incomingStartBar: intro, bassSwapBar: 0 };
  }
  let cut = outgoing.barCount - PHRASE_BARS;
  while (cut >= earliest && !onGrid(cut, originOut)) cut--;
  if (cut < earliest) {
    cut = Math.max(earliest, 0);
    while (cut < outgoing.barCount && !onGrid(cut, originOut)) cut++;
    if (cut >= outgoing.barCount) cut = Math.min(Math.max(earliest, 0), Math.max(0, outgoing.barCount - 1));
  }
  return { overlapBars: 0, outgoingStartBar: cut, incomingStartBar: intro, bassSwapBar: 0 };
}

/**
 * Overlap bar of the bass swap: on the incoming drop when it falls well inside the overlap,
 * otherwise halfway. Never in the first or last quarter, so the blend has room either side.
 */
function bassSwapBar(overlap: number, dropInOverlap: number): number {
  const margin = overlap / 4;
  if (dropInOverlap >= margin && dropInOverlap <= overlap - margin) return dropInOverlap;
  return overlap / 2;
}

/** Section starts and the 16-bar lattice of the phrase grid, ascending. */
function entryBars(phrases: Phrase[], barCount: number, origin: number): number[] {
  const bars = new Set(phrases.map((p) => p.startBar).filter((bar) => bar > 0));
  for (let bar = origin; bar < barCount; bar += ENTRY_BARS) if (bar > 0) bars.add(bar);
  return [...bars].sort((a, b) => a - b);
}
