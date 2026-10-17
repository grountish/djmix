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

/*
 * Scoring. Beats are what a listener holds on to during a blend: before the bass swap only
 * the outgoing kick is heard (the incoming low end is cut), so the outgoing must still have
 * its kick there, and the incoming track should enter on a groove rather than a beatless
 * intro. Penalties grow with the square of the offending bars, so a few bars of pads are
 * fine and a whole phrase of them is not.
 */
/** Per beatless bar (squared) before the swap, either track. */
const BEATLESS_WEIGHT = 1 / 8;
/**
 * Per bar (squared) of the incoming track's full-energy section played with its bass cut.
 * Light: entering with the bass cut for 8–16 bars is normal; a whole minute of it is thin.
 */
const HEADLESS_WEIGHT = 1 / 32;
/** The incoming track's first drop lands exactly on the bass swap: its bass arrives with its drop. */
const DROP_ON_SWAP = 10;
/** The outgoing track's low end leaves of its own accord on the swap bar (its outro begins). */
const NATURAL_SWAP = 6;
/** Longer blends are smoother: half a point per bar. */
const LENGTH_WEIGHT = 0.5;
/** Auto: mixing earlier than the latest possible point wastes the outgoing track, a little. */
const EARLY_WEIGHT = 0.15;
/** Mix now: a later entry than the next one needs a good reason. */
const LATE_WEIGHT = 1;
/** Per bar the incoming drop comes after the swap: the energy should carry on, not wait. */
const DROP_DELAY_WEIGHT = 0.05;
/** Intro bars before the first phrase line that are played rather than skipped. */
const MAX_PICKUP_BARS = 2;

/**
 * Where to mix. Both tracks change on their phrase grids at the same moment. Every
 * combination of overlap length, outgoing start, incoming cue and bass-swap bar is scored:
 * both tracks should have their kick before the swap, the incoming drop should land on the
 * swap (or failing that the outgoing bass should leave there), longer is better, and for Auto
 * later is better while Mix now wants the next entry.
 */
export function chooseMixPoints(input: MixPointInput): MixPoints {
  const { outgoing, incoming } = input;
  const originOut = phraseOrigin(outgoing.phrases);
  const originIn = phraseOrigin(incoming.phrases);
  const drop = firstDropBar(incoming.phrases);
  const earliest = Math.ceil(outgoing.currentBar + input.leadBars);
  const kickOut = barFlags(outgoing.phrases, outgoing.barCount, (p) => p.hasKick);
  const kickIn = barFlags(incoming.phrases, incoming.barCount, (p) => p.hasKick);
  const fullIn = barFlags(incoming.phrases, incoming.barCount, (p) => p.hasKick && p.hasBass);
  const exits = energyExits(outgoing.phrases);
  const entries = energyEntries(incoming.phrases);
  const nowEntries = input.timing === 'now' ? entryBars(outgoing.phrases, outgoing.barCount, originOut) : [];
  const firstEntry = nowEntries.find((bar) => bar >= earliest);

  // Cues sit on the incoming phrase grid, so its phrases land on the outgoing ones.
  const cues: number[] = [];
  for (let bar = 0; bar <= drop; bar++) if (onGrid(bar, originIn)) cues.push(bar);
  if (cues.length === 0) cues.push(0);

  let best: (MixPoints & { score: number }) | null = null;
  for (const overlap of OVERLAP_CHOICES) {
    if (overlap > input.maxOverlapBars) continue;
    const latest = outgoing.barCount - overlap;
    const starts: number[] = [];
    if (input.timing === 'now') {
      const entry = nowEntries.find((bar) => bar >= earliest && bar <= latest);
      if (entry !== undefined) starts.push(entry);
    } else {
      for (let bar = latest; bar >= earliest; bar--) if (onGrid(bar, originOut)) starts.push(bar);
    }

    for (const start of starts) {
      const timing =
        input.timing === 'now' ? LATE_WEIGHT * (start - (firstEntry ?? start)) : EARLY_WEIGHT * (latest - start);
      for (const cue of cues) {
        for (const swap of swapCandidates(overlap, cue, entries, start, exits)) {
          let score = LENGTH_WEIGHT * overlap - timing;
          // Before the swap the outgoing kick carries the beat; the incoming carries it after,
          // and should have a groove to enter on before.
          score -= BEATLESS_WEIGHT * countFalse(kickOut, start, swap) ** 2;
          score -= BEATLESS_WEIGHT * countFalse(kickIn, cue, overlap) ** 2;
          score -= HEADLESS_WEIGHT * countTrue(fullIn, cue, swap) ** 2;
          const swapBar = cue + swap;
          if (entries.includes(swapBar)) score += DROP_ON_SWAP;
          else {
            const next = entries.find((bar) => bar > swapBar);
            if (next !== undefined) score -= DROP_DELAY_WEIGHT * (next - swapBar);
          }
          if (exits.includes(start + swap)) score += NATURAL_SWAP;
          if (!best || score > best.score) {
            best = { overlapBars: overlap, outgoingStartBar: start, incomingStartBar: cue, bassSwapBar: swap, score };
          }
        }
      }
    }
  }
  if (best) {
    // A short pickup before the incoming track's first phrase line (a bar or two of intro)
    // comes along: both tracks start that much earlier, so the phrase lines still coincide.
    const pickup =
      best.incomingStartBar === originIn && originIn > 0 && originIn <= MAX_PICKUP_BARS && best.outgoingStartBar - originIn >= earliest
        ? originIn
        : 0;
    return {
      overlapBars: best.overlapBars + pickup,
      outgoingStartBar: best.outgoingStartBar - pickup,
      incomingStartBar: best.incomingStartBar - pickup,
      bassSwapBar: best.bassSwapBar + pickup,
    };
  }

  // No blend: cut straight into the incoming track's main section so the energy carries on —
  // at the next entry for 'now', else on the last phrase line before the final phrase.
  if (input.timing === 'now') {
    const entry = nowEntries.find((bar) => bar >= earliest && bar < outgoing.barCount);
    if (entry !== undefined) return { overlapBars: 0, outgoingStartBar: entry, incomingStartBar: drop, bassSwapBar: 0 };
  }
  let cut = outgoing.barCount - PHRASE_BARS;
  while (cut >= earliest && !onGrid(cut, originOut)) cut--;
  if (cut < earliest) {
    cut = Math.max(earliest, 0);
    while (cut < outgoing.barCount && !onGrid(cut, originOut)) cut++;
    if (cut >= outgoing.barCount) cut = Math.min(Math.max(earliest, 0), Math.max(0, outgoing.barCount - 1));
  }
  return { overlapBars: 0, outgoingStartBar: cut, incomingStartBar: drop, bassSwapBar: 0 };
}

/**
 * Swap bars worth trying: where the incoming track's full energy arrives, where the outgoing
 * low end leaves, and the quarter marks. Never in the first or last quarter, so the blend has
 * room either side.
 */
function swapCandidates(overlap: number, cue: number, entries: number[], start: number, exits: number[]): number[] {
  const margin = overlap / 4;
  const inRange = (bar: number) => Number.isInteger(bar) && bar >= margin && bar <= overlap - margin;
  const candidates = new Set<number>([margin, overlap / 2, overlap - margin]);
  for (const entry of entries) if (inRange(entry - cue)) candidates.add(entry - cue);
  for (const exit of exits) if (inRange(exit - start)) candidates.add(exit - start);
  return [...candidates];
}

/**
 * Per-bar flags from the phrases; null when no phrase has the property (the analysis found
 * no kick anywhere, say), so nothing is known and nothing is penalised.
 */
function barFlags(phrases: Phrase[], barCount: number, test: (p: Phrase) => boolean): boolean[] | null {
  if (!phrases.some(test)) return null;
  const flags = new Array<boolean>(barCount).fill(false);
  for (const phrase of phrases) {
    const end = Math.min(barCount, phrase.startBar + phrase.bars);
    for (let bar = phrase.startBar; bar < end; bar++) flags[bar] = test(phrase);
  }
  return flags;
}

/** Bars without the flag in [from, from + count); bars past the end of the track count too. */
function countFalse(flags: boolean[] | null, from: number, count: number): number {
  if (!flags) return 0;
  let n = 0;
  for (let bar = from; bar < from + count; bar++) if (!flags[bar]) n++;
  return n;
}

function countTrue(flags: boolean[] | null, from: number, count: number): number {
  if (!flags) return 0;
  let n = 0;
  for (let bar = from; bar < from + count; bar++) if (flags[bar]) n++;
  return n;
}

/** Bars where the incoming track's kick and bass arrive together: its drops. */
function energyEntries(phrases: Phrase[]): number[] {
  const entries: number[] = [];
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    const before = phrases[i - 1];
    const full = phrase.hasKick && phrase.hasBass;
    if (full && (!before || !(before.hasKick && before.hasBass))) entries.push(phrase.startBar);
  }
  return entries;
}

/** Bars where the outgoing track's kick or bass stops: its low end leaves by itself there. */
function energyExits(phrases: Phrase[]): number[] {
  const exits: number[] = [];
  for (let i = 1; i < phrases.length; i++) {
    const before = phrases[i - 1];
    const after = phrases[i];
    if ((before.hasKick && !after.hasKick) || (before.hasBass && !after.hasBass)) exits.push(after.startBar);
  }
  return exits;
}

/** Section starts and the 16-bar lattice of the phrase grid, ascending. */
function entryBars(phrases: Phrase[], barCount: number, origin: number): number[] {
  const bars = new Set(phrases.map((p) => p.startBar).filter((bar) => bar > 0));
  for (let bar = origin; bar < barCount; bar += ENTRY_BARS) if (bar > 0) bars.add(bar);
  return [...bars].sort((a, b) => a - b);
}
