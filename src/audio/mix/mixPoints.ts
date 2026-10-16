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
}

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

/**
 * Where to mix. Both tracks change on their phrase grids at the same moment: the overlap ends
 * where the outgoing track runs out, as late as possible, and the incoming intro is placed so
 * its first drop lands right as the overlap ends. Longer overlaps are preferred when the intro
 * is long enough and there is time to reach them.
 */
export function chooseMixPoints(input: MixPointInput): MixPoints {
  const { outgoing, incoming } = input;
  const originOut = phraseOrigin(outgoing.phrases);
  const originIn = phraseOrigin(incoming.phrases);
  const intro = firstDropBar(incoming.phrases);
  const earliest = Math.ceil(outgoing.currentBar + input.leadBars);

  for (const overlap of OVERLAP_CHOICES) {
    if (overlap > input.maxOverlapBars) continue;
    // Long overlaps need an intro to play over; an intro-less track still gets 8 bars.
    if (overlap > Math.max(intro, PHRASE_BARS)) continue;

    let start = outgoing.barCount - overlap;
    while (start >= earliest && !onGrid(start, originOut)) start--;
    if (start < earliest) continue;

    let incomingStart = Math.max(0, intro - overlap);
    while (incomingStart > 0 && !onGrid(incomingStart, originIn)) incomingStart--;

    return {
      overlapBars: overlap,
      outgoingStartBar: start,
      incomingStartBar: incomingStart,
      bassSwapBar: overlap / 2,
    };
  }

  // No blend: cut on the last phrase line that leaves the outgoing track's final phrase out,
  // straight into the incoming track's main section so the energy carries on.
  let cut = outgoing.barCount - PHRASE_BARS;
  while (cut >= earliest && !onGrid(cut, originOut)) cut--;
  if (cut < earliest) {
    cut = Math.max(earliest, 0);
    while (cut < outgoing.barCount && !onGrid(cut, originOut)) cut++;
    if (cut >= outgoing.barCount) cut = Math.min(Math.max(earliest, 0), Math.max(0, outgoing.barCount - 1));
  }
  return { overlapBars: 0, outgoingStartBar: cut, incomingStartBar: intro, bassSwapBar: 0 };
}
