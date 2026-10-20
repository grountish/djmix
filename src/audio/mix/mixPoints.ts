import type { Phrase } from '../analysis/types';

const PHRASE_BARS = 8;
const OVERLAP_CHOICES = [32, 16, 8];

export interface MixPointTrack {
  phrases: Phrase[];
  /** Full bars from the first downbeat. */
  barCount: number;
  /**
   * Low-band level per bar (dB) as the deck will play it (its loudness trim included), so the
   * bass swap avoids a hole: the incoming bass arriving far below the outgoing one.
   */
  lowDb?: number[];
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
  /**
   * The user's choice of outgoing bar for the incoming track to enter on. Used when it can
   * still be reached and leaves room for a blend; otherwise ignored.
   */
  startBar?: number;
  /** 'blend' (default) or 'loop': see MixStyle. */
  style?: MixStyle;
}

export type MixTiming = 'now' | 'end';

/**
 * 'blend': the tracks overlap as they are; the outgoing one loops only when it runs out of bars.
 * 'loop': the incoming track holds a sparse phrase of its intro (anything short of kick and
 * bassline together: pads, percussion, a kick or a bassline alone) on a loop while it fades in,
 * then plays on into its drop; the outgoing loops its last kick phrase whenever that makes the
 * blend better, not only when it is short of bars.
 */
export type MixStyle = 'blend' | 'loop';

export const MIX_STYLES: { style: MixStyle; label: string }[] = [
  { style: 'blend', label: 'Blend' },
  { style: 'loop', label: 'Loop' },
];

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
  /** A phrase of the outgoing track repeated to make room for the blend (see OutgoingLoop). */
  outgoingLoop?: OutgoingLoop;
  /** A sparse phrase of the incoming intro held while it fades in (see IncomingLoop). */
  incomingLoop?: IncomingLoop;
}

/**
 * The outgoing track loops bars [startBar, startBar + bars) from the moment it reaches their
 * end until it is stopped, so a blend can be longer than the track has bars left. Outgoing bars
 * in a plan count along this timeline: bar startBar + bars is the loop start again, and so on.
 */
export interface OutgoingLoop {
  startBar: number;
  bars: number;
}

/**
 * The incoming track plays bars [startBar, startBar + bars) `repeats` more times before it plays
 * on from their end. Incoming bars in a plan count along this timeline: bar startBar + bars is
 * the loop start again until the repeats are done, then the track bar `repeats × bars` lower.
 */
export interface IncomingLoop extends OutgoingLoop {
  repeats: number;
}

/** Timeline bar → track bar, with the loop repeating from its end (for good, or `repeats` times). */
export function loopedTrackBar(loop: OutgoingLoop | IncomingLoop | undefined, bar: number): number {
  if (!loop) return bar;
  const end = loop.startBar + loop.bars;
  if (bar < end) return bar;
  if ('repeats' in loop && bar >= end + loop.repeats * loop.bars) return bar - loop.repeats * loop.bars;
  return loop.startBar + ((bar - loop.startBar) % loop.bars);
}

/** Jumps back to the loop start up to and including timeline `bar`. */
export function loopWrapsBy(loop: OutgoingLoop | IncomingLoop | undefined, bar: number): number {
  if (!loop) return 0;
  const end = loop.startBar + loop.bars;
  const wraps = bar < end ? 0 : Math.floor((bar - end) / loop.bars) + 1;
  return 'repeats' in loop ? Math.min(loop.repeats, wraps) : wraps;
}

/**
 * A track's phrase lines, read off its sections: a line every 8 bars from each section's start,
 * except where fewer than 8 bars of it are left (a break that moves the grid stands alone as a
 * section shorter than two phrases), and a first section that isn't a whole number of phrases
 * (a pickup before the grid, or one an older analysis merged with what followed) has its lines
 * after the pickup. The track's last section runs on the grid to the end. The grid can move
 * within a track (see `choosePhraseLines`).
 */
export interface PhraseGrid {
  /** Ascending. */
  lines: number[];
  isLine: (bar: number) => boolean;
  /** Lines and the middle of every regular phrase (half a phrase before the first line too). */
  isHalfLine: (bar: number) => boolean;
  /** Bars before the first line when the track starts off the grid; 0 otherwise. */
  pickup: number;
  /** The first line at or after `bar`. */
  nextLine: (bar: number) => number | undefined;
}

export function phraseGrid(phrases: Phrase[]): PhraseGrid {
  const lines: number[] = [];
  let pickup = 0;
  phrases.forEach((phrase, i) => {
    const end = phrase.startBar + phrase.bars;
    const last = i === phrases.length - 1;
    let first = phrase.startBar;
    // A lone section says nothing about where the grid starts: it starts on bar 0.
    if (i === 0 && phrase.bars % PHRASE_BARS !== 0 && !last) {
      pickup = phrase.bars % PHRASE_BARS;
      first += pickup;
    }
    for (let bar = first; bar < end; bar += PHRASE_BARS) {
      if (bar === first || last || end - bar >= PHRASE_BARS) lines.push(bar);
    }
  });
  if (lines.length === 0) lines.push(0);
  const set = new Set(lines);
  const half = new Set(lines);
  lines.forEach((bar, i) => {
    if (lines[i + 1] === bar + PHRASE_BARS) half.add(bar + PHRASE_BARS / 2);
  });
  if (lines[0] >= PHRASE_BARS / 2) half.add(lines[0] - PHRASE_BARS / 2);
  return {
    lines,
    isLine: (bar) => set.has(bar),
    isHalfLine: (bar) => half.has(bar),
    pickup,
    nextLine: (bar) => lines.find((line) => line >= bar),
  };
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
/**
 * Auto: the blend ends where the outgoing track ends, give or take a phrase. The track is
 * heard to its end: an exit at an earlier breakdown may be smoother, but it leaves the last
 * drop unplayed (a minute of the track, on real tracks).
 */
const END_SLACK_BARS = PHRASE_BARS;
/**
 * Auto: per bar the blend ends before the track does; a phrase early needs a reason (a drop
 * on the swap, a natural exit, a beat under the blend). Not for a looped outro: the loop is
 * the track's end, and its repeats are counted separately.
 */
const EARLY_WEIGHT = 0.5;
/** Mix now: a later entry than the next one needs a good reason. */
const LATE_WEIGHT = 1;
/** Per bar the incoming drop comes after the swap: the energy should carry on, not wait. */
const DROP_DELAY_WEIGHT = 0.05;
/** Intro bars before the first phrase line that are played rather than skipped. */
const MAX_PICKUP_BARS = 2;
/** Per bar of the incoming track skipped past its first drop. */
const SKIP_WEIGHT = 0.05;
/**
 * The incoming track is never cued later than this share of its length. Skipping a beatless
 * intro is fine; entering at a later drop is not — a track is a few minutes long and is meant
 * to be heard (the user's rule: at most a quarter skipped).
 */
const MAX_CUE_FRACTION = 0.25;
/** A blend shorter than this is worth looping the outgoing track for. */
const LOOP_BELOW_BARS = 16;
/** Loop style: the incoming intro is held for at most this many extra bars. */
const MAX_INTRO_EXTRA_BARS = 3 * PHRASE_BARS;
/** Loop style: a whole phrase, or half of one where the intro is too short for a whole one. */
const INTRO_LOOP_BARS = [PHRASE_BARS, PHRASE_BARS / 2];
/**
 * Loop style: a phrase quieter than the track's loudest by more than this is a fade-in or
 * near-silence, not an intro to hold.
 */
const INTRO_LOOP_MIN_LEVEL_DB = -18;
/**
 * Loop style: holding the incoming intro on a loop is what the style is for, so it wins over a
 * plain blend that scores about the same; each extra phrase costs a point, so it loops no more
 * than the blend needs (to bring the drop onto the swap, to stretch a short intro over the fade-in).
 */
const INTRO_LOOP_BONUS = 4;
const INTRO_REPEAT_WEIGHT = 1;
/**
 * Loop style: per beatless incoming bar before the swap, linear. The outgoing kick carries the
 * beat until then, so a pad or percussion intro under it is the technique, not a flaw; from
 * the swap on the incoming track needs its kick as in a blend.
 */
const LOOP_STYLE_BEATLESS_WEIGHT = 1 / 16;
/** Each repeat of the loop is heard as one; a couple pass as an extended outro, more don't. */
const LOOP_WRAP_WEIGHT = 1.5;
const MAX_LOOP_WRAPS = 2;
/** A loop whose bars all carry the bassline sounds like the track, not a stutter. */
const LOOP_BASS_BONUS = 1;
/**
 * Per dB² the incoming low end arrives below the outgoing one at the swap, past a tolerance:
 * a hole in the bass. 10 dB costs more than a drop landing on the swap earns.
 */
const BASS_HOLE_WEIGHT = 0.25;
const BASS_HOLE_TOLERANCE_DB = 3;
const MAX_BASS_HOLE_DB = 30;
/** Bars averaged on each side of the swap for the hole. */
const BASS_HOLE_BARS = 2;
/**
 * Per overlap bar after either track's phrase lines stop meeting the other's: a grid that
 * moves (a 4-bar break) inside the blend puts every phrase after it half a phrase off.
 */
const PHRASE_DRIFT_WEIGHT = 0.5;

/**
 * Where to mix. Both tracks change on their phrase grids at the same moment. Every
 * combination of overlap length, outgoing start, incoming cue and bass-swap bar is scored:
 * both tracks should have their kick before the swap, the incoming drop should land on the
 * swap (or failing that the outgoing bass should leave there), longer is better, Auto ends the
 * blend within a phrase of the track's end while Mix now wants the next entry. When the
 * outgoing track hasn't the bars left for a 16-bar blend, one of its kick phrases is looped to
 * make them. The loop style also tries every sparse phrase of the incoming intro held on a loop
 * (its drop then comes that much later), and loops the outgoing track whenever that scores better.
 */
export function chooseMixPoints(input: MixPointInput): MixPoints {
  const { outgoing, incoming } = input;
  const gridOut = phraseGrid(outgoing.phrases);
  const gridIn = phraseGrid(incoming.phrases);
  const drop = firstDropBar(incoming.phrases);
  const earliest = Math.ceil(outgoing.currentBar + input.leadBars);
  const kickOut = barFlags(outgoing.phrases, outgoing.barCount, (p) => p.hasKick);
  const bassOut = barFlags(outgoing.phrases, outgoing.barCount, (p) => p.hasBass);
  const kickIn = barFlags(incoming.phrases, incoming.barCount, (p) => p.hasKick);
  const fullIn = barFlags(incoming.phrases, incoming.barCount, (p) => p.hasKick && p.hasBass);
  const exits = energyExits(outgoing.phrases);
  const entries = energyEntries(incoming.phrases);
  const nowEntries = input.timing === 'now' ? entryBars(outgoing.phrases, gridOut) : [];
  const firstEntry = nowEntries.find((bar) => bar >= earliest);

  // Cues sit on the incoming phrase grid, so its phrases land on the outgoing ones. They reach
  // as far as its last drop: a track whose first kick section is short may be better entered
  // later, at the cost of the music skipped.
  const latestCue = Math.floor(incoming.barCount * MAX_CUE_FRACTION);
  const lastEntry = Math.min(latestCue, entries.length ? entries[entries.length - 1] : drop);
  const cues: number[] = [];
  for (const bar of gridIn.lines) if (bar <= lastEntry) cues.push(bar);
  // A track whose first drop comes before its first line (or that has none) enters on that line.
  if (cues.length === 0) cues.push(gridIn.lines[0]);

  const forcedStart = input.startBar !== undefined && input.startBar >= earliest ? input.startBar : undefined;
  const loopStyle = input.style === 'loop';

  // The incoming track as the overlap hears it: with an intro loop its bars run along the looped
  // timeline, so everything from the loop's end on (its drops) comes that many bars later. The
  // cue is never past the loop, so the loop is heard from its first bar, and sits where the
  // phrase grid lands after the loop: its phrase lines meet the outgoing ones from there on
  // (a 4-bar intro before the grid, looped once, puts the drop a phrase after a cue on bar 0).
  const introCues = (intro: IncomingLoop, extra: number) => {
    const line = gridIn.nextLine(intro.startBar + intro.bars);
    if (line === undefined) return [];
    const out: number[] = [];
    for (let bar = 0; bar <= Math.min(intro.startBar, latestCue); bar++) if ((line + extra - bar) % PHRASE_BARS === 0) out.push(bar);
    return out;
  };
  const incomingView = (intro: IncomingLoop | undefined) => {
    if (!intro) return { kick: kickIn, full: fullIn, lowDb: incoming.lowDb, entries, drop, cues, isLine: gridIn.isLine };
    const extra = intro.repeats * intro.bars;
    const loopEnd = intro.startBar + intro.bars;
    const timeline = <T>(values: T[]) =>
      Array.from({ length: values.length + extra }, (_, bar) => values[loopedTrackBar(intro, bar)]);
    const later = (bar: number) => (bar < intro.startBar + intro.bars ? bar : bar + extra);
    return {
      kick: kickIn && timeline(kickIn),
      full: fullIn && timeline(fullIn),
      lowDb: incoming.lowDb && timeline(incoming.lowDb),
      entries: entries.map(later),
      drop: later(drop),
      cues: introCues(intro, extra),
      // Lines before the loop, none inside its repeats, the track's own moved on after it.
      isLine: (bar: number) => (bar < loopEnd ? gridIn.isLine(bar) : bar >= loopEnd + extra && gridIn.isLine(bar - extra)),
    };
  };

  type Scored = MixPoints & { score: number };
  const search = (loop: OutgoingLoop | undefined, intro?: IncomingLoop): Scored | null => {
    const trackBar = (bar: number) => loopedTrackBar(loop, bar);
    const { kick: kickIn, full: fullIn, lowDb: incomingLow, entries, drop, cues, isLine: isLineIn } = incomingView(intro);
    const introEnd = intro ? intro.startBar + intro.bars * (intro.repeats + 1) : 0;
    const kickAt = (bar: number) => !kickOut || kickOut[trackBar(bar)];
    // The loop runs on until the deck is stopped; the overlap must begin by its first repeat
    // so that everything before the overlap is the track as it is (countdowns rely on it).
    const loopEnd = loop ? loop.startBar + loop.bars : Infinity;
    // Outgoing lines along the looped timeline: the loop's phrase starts over every 8 bars.
    const isLineOut = (bar: number) => (bar < loopEnd ? gridOut.isLine(bar) : (bar - loopEnd) % PHRASE_BARS === 0);
    // Overlap bars from the first line of `isLine` that isn't a whole number of phrases after `from`.
    const drift = (isLine: (bar: number) => boolean, from: number, overlap: number) => {
      for (let bar = from + 1; bar < from + overlap; bar++) if (isLine(bar) && (bar - from) % PHRASE_BARS !== 0) return from + overlap - bar;
      return 0;
    };
    let best: Scored | null = null;
    for (const overlap of OVERLAP_CHOICES) {
      if (overlap > input.maxOverlapBars) continue;
      if (loop && overlap < LOOP_BELOW_BARS) continue;
      const latest = loop ? loopEnd : outgoing.barCount - overlap;
      const starts: number[] = [];
      if (forcedStart !== undefined) {
        if (forcedStart <= latest) starts.push(forcedStart);
      } else if (input.timing === 'now') {
        const entry = nowEntries.find((bar) => bar >= earliest && bar <= latest);
        if (entry !== undefined) starts.push(entry);
        // The first repeat is an entry of its own: the phrase starts over there.
        if (loop && loopEnd >= earliest && entry !== loopEnd) starts.push(loopEnd);
      } else {
        // Auto: the track plays to its end (a looped phrase is its end). The deck's own outro
        // or last drop is what the incoming track comes in over.
        const earliestStart = loop ? earliest : Math.max(earliest, outgoing.barCount - overlap - END_SLACK_BARS);
        for (let bar = latest; bar >= earliestStart; bar--) if (gridOut.isLine(bar)) starts.push(bar);
      }

      for (const start of starts) {
        // The blend reaches the loop (else it is a plain blend, and those were searched) and
        // doesn't outstay it.
        const wraps = loopWrapsBy(loop, start + overlap - 1);
        if (loop && (wraps === 0 || wraps > MAX_LOOP_WRAPS)) continue;
        const timing =
          input.timing === 'now' ? LATE_WEIGHT * (start - (firstEntry ?? start)) : loop ? 0 : EARLY_WEIGHT * (latest - start);
        const driftOut = drift(isLineOut, start, overlap);
        for (const cue of cues) {
          const drifted = PHRASE_DRIFT_WEIGHT * Math.max(driftOut, drift(isLineIn, cue, overlap));
          for (const swap of swapCandidates(overlap, cue, entries, start, exits)) {
            // The intro loop is over by the swap: the incoming bass comes in with the track playing on.
            if (intro && introEnd > cue + swap) continue;
            let score = LENGTH_WEIGHT * overlap - timing - drifted - SKIP_WEIGHT * Math.max(0, cue - drop);
            // Before the swap the outgoing kick carries the beat; the incoming carries it after,
            // and should have a groove to enter on before.
            let beatless = 0;
            for (let bar = start; bar < start + swap; bar++) if (!kickAt(bar)) beatless++;
            score -= BEATLESS_WEIGHT * beatless ** 2;
            if (loopStyle) {
              score -= LOOP_STYLE_BEATLESS_WEIGHT * countFalse(kickIn, cue, swap);
              score -= BEATLESS_WEIGHT * countFalse(kickIn, cue + swap, overlap - swap) ** 2;
            } else score -= BEATLESS_WEIGHT * countFalse(kickIn, cue, overlap) ** 2;
            score -= HEADLESS_WEIGHT * countTrue(fullIn, cue, swap) ** 2;
            const swapBar = cue + swap;
            if (entries.includes(swapBar)) score += DROP_ON_SWAP;
            else {
              const next = entries.find((bar) => bar > swapBar);
              if (next !== undefined) score -= DROP_DELAY_WEIGHT * (next - swapBar);
            }
            // The outgoing low end leaves by itself only where the track still runs its course.
            if (loopWrapsBy(loop, start + swap) === 0 && exits.includes(start + swap)) score += NATURAL_SWAP;
            score -= BASS_HOLE_WEIGHT * bassHole(outgoing.lowDb, incomingLow, trackBar, start, cue, swap) ** 2;
            if (loop) {
              score -= LOOP_WRAP_WEIGHT * wraps;
              if (bassOut && countTrue(bassOut, loop.startBar, loop.bars) === loop.bars) score += LOOP_BASS_BONUS;
            }
            if (intro) score += INTRO_LOOP_BONUS - (INTRO_REPEAT_WEIGHT * intro.repeats * intro.bars) / PHRASE_BARS;
            if (!best || score > best.score) {
              best = { overlapBars: overlap, outgoingStartBar: start, incomingStartBar: cue, bassSwapBar: swap, score };
              if (loop) best.outgoingLoop = loop;
              if (intro) best.incomingLoop = intro;
            }
          }
        }
      }
    }
    return best;
  };

  const intros: (IncomingLoop | undefined)[] = [undefined];
  if (loopStyle) {
    for (const window of introLoopCandidates(incoming.phrases, gridIn, entries[0] ?? incoming.barCount, fullIn)) {
      for (let repeats = 1; repeats * window.bars <= MAX_INTRO_EXTRA_BARS; repeats++) intros.push({ ...window, repeats });
    }
  }
  const searchAll = (loop: OutgoingLoop | undefined, current: Scored | null): Scored | null => {
    for (const intro of intros) {
      const found = search(loop, intro);
      if (found && (!current || found.score > current.score)) current = found;
    }
    return current;
  };

  let best = searchAll(undefined, null);
  if (loopStyle || !best || best.overlapBars < LOOP_BELOW_BARS) {
    // Loop candidates: one phrase on the outgoing grid, kick throughout, still ahead of the
    // deck (its end is where the first jump back happens) and inside the track. For Auto it is
    // the track's last phrase: a loop stands in for the end, not for the rest of the track.
    const minLoopEnd = input.timing === 'now' ? 0 : outgoing.barCount - END_SLACK_BARS;
    for (const loop of loopCandidates(outgoing.barCount, gridOut, Math.max(earliest, minLoopEnd), kickOut)) {
      best = searchAll(loop, best);
    }
  }

  if (best) {
    // A short pickup before the incoming track's first phrase line (a bar or two of intro)
    // comes along: both tracks start that much earlier, so the phrase lines still coincide.
    const pickup =
      best.incomingStartBar === gridIn.pickup &&
      gridIn.pickup > 0 &&
      gridIn.pickup <= MAX_PICKUP_BARS &&
      best.outgoingStartBar - gridIn.pickup >= earliest
        ? gridIn.pickup
        : 0;
    return {
      overlapBars: best.overlapBars + pickup,
      outgoingStartBar: best.outgoingStartBar - pickup,
      incomingStartBar: best.incomingStartBar - pickup,
      bassSwapBar: best.bassSwapBar + pickup,
      ...(best.outgoingLoop ? { outgoingLoop: best.outgoingLoop } : {}),
      ...(best.incomingLoop ? { incomingLoop: best.incomingLoop } : {}),
    };
  }

  // No blend: cut straight into the incoming track's main section so the energy carries on —
  // at the next entry for 'now', else on the last phrase line before the final phrase.
  if (input.timing === 'now') {
    const entry = nowEntries.find((bar) => bar >= earliest && bar < outgoing.barCount);
    if (entry !== undefined) return { overlapBars: 0, outgoingStartBar: entry, incomingStartBar: Math.min(drop, latestCue), bassSwapBar: 0 };
  }
  let cut = outgoing.barCount - PHRASE_BARS;
  while (cut >= earliest && !gridOut.isLine(cut)) cut--;
  if (cut < earliest) {
    cut = Math.max(earliest, 0);
    while (cut < outgoing.barCount && !gridOut.isLine(cut)) cut++;
    if (cut >= outgoing.barCount) cut = Math.min(Math.max(earliest, 0), Math.max(0, outgoing.barCount - 1));
  }
  return { overlapBars: 0, outgoingStartBar: cut, incomingStartBar: Math.min(drop, latestCue), bassSwapBar: 0 };
}

/** Phrases of the outgoing track that can be looped, latest first. None without kick information. */
function loopCandidates(barCount: number, grid: PhraseGrid, earliest: number, kick: boolean[] | null): OutgoingLoop[] {
  if (!kick) return [];
  const loops: OutgoingLoop[] = [];
  for (let start = barCount - PHRASE_BARS; start >= 0; start--) {
    if (!wholePhrase(grid, start, barCount) || start + PHRASE_BARS < earliest) continue;
    if (countTrue(kick, start, PHRASE_BARS) === PHRASE_BARS) loops.push({ startBar: start, bars: PHRASE_BARS });
  }
  return loops;
}

/**
 * Stretches of the incoming intro that can be held on a loop while it fades in: a phrase on its
 * grid (or half of one, on the half-phrase grid), before `until` (its first drop), without the
 * full energy of kick and bassline together, and not a fade-in or near-silence. A kick to lock
 * on isn't needed: the outgoing track carries the beat until the swap.
 */
function introLoopCandidates(phrases: Phrase[], grid: PhraseGrid, until: number, full: boolean[] | null): OutgoingLoop[] {
  const loudest = Math.max(...phrases.map((p) => p.energyDb));
  const quiet = (bar: number) => {
    const phrase = phrases.find((p) => bar >= p.startBar && bar < p.startBar + p.bars);
    return !phrase || phrase.energyDb < loudest + INTRO_LOOP_MIN_LEVEL_DB;
  };
  const loops: OutgoingLoop[] = [];
  for (const bars of INTRO_LOOP_BARS) {
    // Half a phrase only where no whole one fits.
    if (loops.length > 0) break;
    for (let start = 0; start + bars <= until; start++) {
      const fits =
        bars === PHRASE_BARS
          ? wholePhrase(grid, start, until)
          : grid.isHalfLine(start) && grid.isHalfLine(start + bars) && !grid.lines.some((line) => line > start && line < start + bars);
      if (!fits) continue;
      if (countTrue(full, start, bars) > 0) continue;
      let audible = true;
      for (let bar = start; bar < start + bars && audible; bar++) if (quiet(bar)) audible = false;
      if (audible) loops.push({ startBar: start, bars });
    }
  }
  return loops;
}

/**
 * How far (dB, 0 … MAX_BASS_HOLE_DB) the incoming low end at the swap falls below the
 * outgoing one just before it, past the tolerance: the bass hole a listener would hear.
 * Bars past the end of the incoming track are silence; 0 without level information.
 */
function bassHole(
  outLow: number[] | undefined,
  inLow: number[] | undefined,
  trackBar: (bar: number) => number,
  start: number,
  cue: number,
  swap: number,
): number {
  if (!outLow || !inLow || outLow.length === 0) return 0;
  const powerMean = (levels: (number | undefined)[]) => {
    const known = levels.filter((db): db is number => db !== undefined);
    if (known.length === 0) return undefined;
    return 10 * Math.log10(known.reduce((sum, db) => sum + Math.pow(10, db / 10), 0) / known.length);
  };
  const before: (number | undefined)[] = [];
  for (let bar = start + swap - BASS_HOLE_BARS; bar < start + swap; bar++) before.push(outLow[trackBar(bar)]);
  const after: number[] = [];
  for (let bar = cue + swap; bar < cue + swap + BASS_HOLE_BARS; bar++) after.push(inLow[bar] ?? -120);
  const outgoingDb = powerMean(before);
  if (outgoingDb === undefined) return 0;
  return Math.min(MAX_BASS_HOLE_DB, Math.max(0, outgoingDb - powerMean(after)! - BASS_HOLE_TOLERANCE_DB));
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
function entryBars(phrases: Phrase[], grid: PhraseGrid): number[] {
  const bars = new Set(phrases.map((p) => p.startBar).filter((bar) => bar > 0));
  // Every other line, counted from the first line and again after an irregular phrase.
  let runStart = 0;
  grid.lines.forEach((bar, i) => {
    if (i > 0 && bar - grid.lines[i - 1] !== PHRASE_BARS) runStart = i;
    if ((i - runStart) % (ENTRY_BARS / PHRASE_BARS) === 0 && bar > 0) bars.add(bar);
  });
  return [...bars].sort((a, b) => a - b);
}

/** Whether bars [start, start + 8) are one phrase: a line on each end (or the track's end). */
function wholePhrase(grid: PhraseGrid, start: number, end: number): boolean {
  if (!grid.isLine(start) || start + PHRASE_BARS > end) return false;
  const next = grid.nextLine(start + 1);
  return next === undefined || next === start + PHRASE_BARS;
}
