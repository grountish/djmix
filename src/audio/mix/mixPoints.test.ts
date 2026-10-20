import { describe, expect, it } from 'vitest';
import type { Phrase, PhraseLabel } from '../analysis/types';
import { chooseMixPoints, loopedTrackBar, loopWrapsBy, phraseGrid } from './mixPoints';

type Section = [PhraseLabel, number] | [PhraseLabel, number, { kick?: boolean; bass?: boolean; energyDb?: number }];

function phrases(...sections: Section[]): Phrase[] {
  let startBar = 0;
  return sections.map(([label, bars, flags]) => {
    const phrase = {
      startBar,
      bars,
      label,
      hasKick: flags?.kick ?? true,
      hasBass: flags?.bass ?? label === 'drop',
      energyDb: flags?.energyDb ?? -10,
    };
    startBar += bars;
    return phrase;
  });
}

const OUTGOING = phrases(['intro', 16], ['drop', 64], ['breakdown', 16], ['drop', 64], ['outro', 16]);
const INCOMING = phrases(['intro', 16], ['drop', 64], ['outro', 16]);

describe('chooseMixPoints', () => {
  const input = {
    outgoing: { phrases: OUTGOING, barCount: 176, currentBar: 20 },
    incoming: { phrases: INCOMING, barCount: 96 },
    leadBars: 5,
    maxOverlapBars: 32,
  };

  it('mixes where the outgoing track runs out by default (Auto)', () => {
    const points = chooseMixPoints(input);
    // The incoming drop (bar 16) lands on the swap, where the outgoing bass leaves (bar 160).
    expect(points).toEqual({ overlapBars: 32, outgoingStartBar: 144, incomingStartBar: 0, bassSwapBar: 16 });
  });

  it('mixes at the next reachable 16-bar entry for Mix now', () => {
    const points = chooseMixPoints({ ...input, timing: 'now' });
    // Bar 25 is the earliest reachable; the next entry is bar 32.
    expect(points.outgoingStartBar).toBe(32);
    expect(points.overlapBars).toBe(32);
    // The 16-bar intro is shorter than the overlap: start at its top, swap the bass on its drop.
    expect(points.incomingStartBar).toBe(0);
    expect(points.bassSwapBar).toBe(16);
  });

  it('prefers a section start when it comes before the next lattice line', () => {
    const points = chooseMixPoints({ ...input, timing: 'now', outgoing: { ...input.outgoing, currentBar: 70 } });
    expect(points.outgoingStartBar).toBe(80);
  });

  it('shortens the overlap near the end rather than skipping the mix', () => {
    const points = chooseMixPoints({ ...input, timing: 'now', outgoing: { ...input.outgoing, currentBar: 150 } });
    expect(points.outgoingStartBar).toBe(160);
    expect(points.overlapBars).toBe(16);
  });

  it('cues past a beatless intro so the incoming track enters on its beat', () => {
    // 32 bars of pads, then the drop: a DJ starts a phrase before the drop, not at the top.
    const incoming = phrases(['intro', 32, { kick: false }], ['drop', 64], ['outro', 16]);
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 112 } });
    expect(points.incomingStartBar).toBe(24);
    expect(points.bassSwapBar).toBe(32 - points.incomingStartBar);
    expect(points.overlapBars).toBe(32);
  });

  it('keeps the incoming beat under the swap when its intro has a beatless stretch', () => {
    // Kick for 8 bars, then 16 beatless bars, then the drop (a real library track).
    const incoming = phrases(
      ['intro', 8, { kick: true }],
      ['intro', 16, { kick: false }],
      ['drop', 64],
      ['outro', 16],
    );
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 104 } });
    // Not bar 0 (the beat would vanish for 16 bars before the swap): one phrase before the drop.
    expect(points.incomingStartBar).toBe(16);
    expect(points.bassSwapBar).toBe(8);
  });

  it('swaps the bass before the outgoing kick stops', () => {
    // A 24-bar beatless outro: the swap must come where the kick leaves, not inside the outro.
    const outgoing = phrases(['intro', 16], ['drop', 64], ['breakdown', 16], ['drop', 64], ['outro', 24, { kick: false }]);
    const points = chooseMixPoints({ ...input, outgoing: { phrases: outgoing, barCount: 184, currentBar: 20 } });
    expect(points.outgoingStartBar + points.bassSwapBar).toBe(160);
    expect(points.overlapBars).toBe(32);
  });

  it('keeps the beat going through a build inside the overlap', () => {
    // Kick and bass from the top, an 8-bar beatless build, then the main drop: the outgoing
    // kick must cover the build, so the swap waits for the drop at bar 21.
    const incoming = phrases(['drop', 13], ['build', 8, { kick: false, bass: true }], ['drop', 176], ['outro', 25, { kick: false, bass: false }]);
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 222 } });
    // Phrase lines run from bar 5 (13 − 8): the cue sits on the first one.
    expect(points.incomingStartBar).toBe(5);
    expect(points.incomingStartBar + points.bassSwapBar).toBe(21);
  });

  it('plays a one-bar pickup before the first phrase line instead of skipping it', () => {
    // One bar of intro, then phrases every 8 bars from bar 1: the phrase lines must still
    // coincide, so both tracks start a bar earlier and the pickup rides over the outgoing's
    // last bar.
    const incoming = phrases(['intro', 1, { kick: false, bass: false }], ['drop', 64], ['outro', 16]);
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 81 } });
    expect(points.incomingStartBar).toBe(0);
    expect(points.overlapBars).toBe(33);
    expect((points.outgoingStartBar + 1) % 8).toBe(0);
    // The swap still falls on an outgoing phrase line (a quarter mark of the original overlap).
    expect((points.outgoingStartBar + points.bassSwapBar) % 8).toBe(0);
  });

  it('keeps cues on the incoming phrase grid when the intro is longer than a pickup', () => {
    // Five bars before the first phrase line: start on that line, not on bar 0.
    const incoming = phrases(['intro', 5, { kick: false, bass: false }], ['drop', 64], ['outro', 16]);
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 85 } });
    expect(points.incomingStartBar).toBe(5);
    expect(points.overlapBars).toBe(32);
  });

  it('never cues past a quarter of the incoming track, even when a later drop would blend better', () => {
    // A 7-bar kick intro (phrase lines from bar 7), an 8-bar drop, a 48-bar kickless breakdown,
    // then a long drop at bar 63. A blend into that drop would be the smoothest, but it would
    // skip almost half the track: the cue stays within the first quarter (36 of 144 bars) and
    // the blend is made shorter instead.
    const incoming = phrases(
      ['intro', 7, { kick: true }],
      ['drop', 8],
      ['breakdown', 48, { kick: false, bass: true }],
      ['drop', 64],
      ['outro', 17],
    );
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 144 } });
    expect(points.incomingStartBar).toBeLessThanOrEqual(36);
    expect(points.overlapBars).toBeGreaterThanOrEqual(8);
  });

  it('caps the cue at a quarter for a cut too', () => {
    // No blend possible (max overlap 0); the only drop is at bar 60 of 100.
    const incoming = phrases(['intro', 60, { kick: false, bass: false }], ['drop', 32], ['outro', 8]);
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 100 }, maxOverlapBars: 0 });
    expect(points.overlapBars).toBe(0);
    expect(points.incomingStartBar).toBeLessThanOrEqual(25);
  });

  describe('the outgoing track is heard to its end (Auto)', () => {
    it('does not mix out at a breakdown a minute before the end, however smooth the exit', () => {
      // A 40-bar kickless breakdown, a final 16-bar drop and a bar of tail (a real library
      // track): swapping where the kick leaves at bar 104 would be the smoothest exit, but it
      // would leave the last minute of the track unplayed.
      const outgoing = phrases(['intro', 16], ['drop', 88], ['breakdown', 40, { kick: false, bass: true }], ['drop', 16], ['outro', 1, { kick: false }]);
      const points = chooseMixPoints({ ...input, outgoing: { phrases: outgoing, barCount: 161, currentBar: 20 } });
      expect(points.outgoingStartBar + points.overlapBars).toBeGreaterThanOrEqual(161 - 8);
      expect(points.overlapBars).toBeGreaterThanOrEqual(16);
    });

    it('does not mix out early to dodge a bass hole at the end', () => {
      // The outgoing's last drop is bass-heavy and the incoming track's drop is thin: a swap at
      // the breakdown (bar 80) would avoid the hole, at the cost of the whole second half.
      const level = (sections: [number, number][]) => sections.flatMap(([bars, db]) => new Array<number>(bars).fill(db));
      const outgoing = {
        phrases: OUTGOING,
        barCount: 176,
        currentBar: 20,
        lowDb: level([[16, -30], [64, -8], [16, -30], [64, -2], [16, -14]]),
      };
      const incoming = { phrases: INCOMING, barCount: 96, lowDb: level([[16, -28], [64, -22], [16, -26]]) };
      const points = chooseMixPoints({ ...input, outgoing, incoming });
      expect(points.outgoingStartBar + points.overlapBars).toBeGreaterThanOrEqual(176 - 8);
    });

    it('blends inside a long beatless outro rather than mixing out before it', () => {
      // 40 beatless bars at the end: the track is still heard to its end, and the swap comes as
      // early as the blend allows so the incoming beat returns soon.
      const outgoing = phrases(['intro', 16], ['drop', 64], ['breakdown', 16], ['drop', 64], ['outro', 40, { kick: false }]);
      const points = chooseMixPoints({ ...input, outgoing: { phrases: outgoing, barCount: 200, currentBar: 20 } });
      expect(points.outgoingStartBar + points.overlapBars).toBeGreaterThanOrEqual(200 - 8);
      expect(points.bassSwapBar).toBeLessThanOrEqual(8);
    });

    it('may end a phrase early for a natural exit, never more', () => {
      // The bass leaves at bar 160 of 168: an exit the swap can land on from a start one
      // phrase before the latest, but not from further back.
      const outgoing = phrases(['intro', 16], ['drop', 64], ['breakdown', 16], ['drop', 64], ['outro', 8]);
      const points = chooseMixPoints({ ...input, outgoing: { phrases: outgoing, barCount: 168, currentBar: 20 } });
      expect(points.outgoingStartBar + points.overlapBars).toBeGreaterThanOrEqual(160);
      expect(points.outgoingStartBar + points.overlapBars).toBeLessThanOrEqual(168);
    });
  });

  it('brings a track that starts at full energy in with an early swap, not a short blend', () => {
    const incoming = phrases(['drop', 120], ['outro', 8]);
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 128 } });
    expect(points.overlapBars).toBe(32);
    expect(points.incomingStartBar).toBe(0);
    expect(points.bassSwapBar).toBe(8);
  });

  describe('a chosen start bar', () => {
    it('starts the overlap there when it can be reached and leaves room', () => {
      const points = chooseMixPoints({ ...input, startBar: 112 });
      expect(points.outgoingStartBar).toBe(112);
      expect(points.overlapBars).toBe(32);
      // The swap still lands on the incoming drop.
      expect(points.incomingStartBar + points.bassSwapBar).toBe(16);
    });

    it('shortens the blend when the bar is close to the end, and ignores one behind the deck', () => {
      expect(chooseMixPoints({ ...input, startBar: 160 }).outgoingStartBar).toBe(160);
      expect(chooseMixPoints({ ...input, startBar: 160 }).overlapBars).toBe(16);
      // Bar 10 is behind the deck (bar 20 + 5 lead): back to the planner's own choice.
      expect(chooseMixPoints({ ...input, startBar: 10 })).toEqual(chooseMixPoints(input));
    });
  });

  describe('looping the outgoing track', () => {
    it('never loops when a 16-bar blend fits', () => {
      expect(chooseMixPoints(input).outgoingLoop).toBeUndefined();
      const late = chooseMixPoints({ ...input, outgoing: { ...input.outgoing, currentBar: 150 } });
      expect(late.overlapBars).toBe(16);
      expect(late.outgoingLoop).toBeUndefined();
    });

    it('loops the last kick phrase for a 16-bar blend when only 8 bars would fit', () => {
      // Bar 158 + 5 lead = 163: the track (176 bars) has 13 left, an 8-bar blend at 168 at best.
      const points = chooseMixPoints({ ...input, outgoing: { ...input.outgoing, currentBar: 158 } });
      expect(points.overlapBars).toBe(16);
      expect(points.outgoingLoop).toEqual({ startBar: 168, bars: 8 });
      // The overlap begins on the last phrase, which then repeats once under the blend.
      expect(points.outgoingStartBar).toBe(168);
      // The incoming drop still lands on the swap.
      expect(points.incomingStartBar + points.bassSwapBar).toBe(16);
    });

    it('loops for Mix now too', () => {
      const points = chooseMixPoints({ ...input, timing: 'now', outgoing: { ...input.outgoing, currentBar: 158 } });
      expect(points.overlapBars).toBeGreaterThanOrEqual(16);
      expect(points.outgoingLoop).toEqual({ startBar: 168, bars: 8 });
    });

    it('only loops phrases with a kick, still ahead of the deck', () => {
      // A 24-bar beatless outro: the kick phrases end at 160, behind a deck at 162.
      const outgoing = phrases(['intro', 16], ['drop', 64], ['breakdown', 16], ['drop', 64], ['outro', 24, { kick: false }]);
      const points = chooseMixPoints({ ...input, outgoing: { phrases: outgoing, barCount: 184, currentBar: 162 } });
      expect(points.outgoingLoop).toBeUndefined();
    });

    it('never loops without kick information', () => {
      const flat = (p: Phrase) => ({ ...p, hasKick: false, hasBass: false });
      const points = chooseMixPoints({
        ...input,
        outgoing: { phrases: OUTGOING.map(flat), barCount: 176, currentBar: 158 },
        incoming: { phrases: INCOMING.map(flat), barCount: 96 },
      });
      expect(points.outgoingLoop).toBeUndefined();
    });

    it('maps the looped timeline back onto the track', () => {
      const loop = { startBar: 24, bars: 8 };
      expect([20, 24, 31, 32, 39, 40, 47].map((bar) => loopedTrackBar(loop, bar))).toEqual([20, 24, 31, 24, 31, 24, 31]);
      expect([20, 31, 32, 39, 40, 48].map((bar) => loopWrapsBy(loop, bar))).toEqual([0, 0, 1, 1, 2, 3]);
      expect(loopedTrackBar(undefined, 99)).toBe(99);
      expect(loopWrapsBy(undefined, 99)).toBe(0);
    });

    it('plays on past a loop with a number of repeats', () => {
      const loop = { startBar: 0, bars: 8, repeats: 2 };
      expect([0, 7, 8, 15, 16, 23, 24, 30, 31.5].map((bar) => loopedTrackBar(loop, bar))).toEqual([0, 7, 0, 7, 0, 7, 8, 14, 15.5]);
      expect([7, 8, 16, 24, 40].map((bar) => loopWrapsBy(loop, bar))).toEqual([0, 1, 2, 2, 2]);
    });
  });

  describe('the phrase grid', () => {
    it('reads the lines off the sections: every 8 bars, after a pickup, and where a break moved them', () => {
      const grid = phraseGrid(phrases(['intro', 2], ['intro', 16], ['drop', 32], ['breakdown', 4], ['drop', 16], ['outro', 5]));
      expect(grid.pickup).toBe(2);
      expect(grid.lines).toEqual([2, 10, 18, 26, 34, 42, 50, 54, 62, 70]);
      expect(grid.isHalfLine(6)).toBe(true);
      expect(grid.isHalfLine(52)).toBe(false);
      // An older analysis merged the pickup into the first section.
      expect(phraseGrid(phrases(['intro', 18], ['drop', 32])).lines).toEqual([2, 10, 18, 26, 34, 42]);
    });

    it('mixes out on the lines of a grid that moved before the end', () => {
      // A 4-bar break at 160: the last phrases start on 164, 172, 180.
      const moved = phrases(['intro', 16], ['drop', 64], ['breakdown', 16], ['drop', 64], ['breakdown', 4], ['drop', 16], ['outro', 8]);
      const points = chooseMixPoints({ ...input, outgoing: { phrases: moved, barCount: 188, currentBar: 20 } });
      expect(points.outgoingStartBar % 8).toBe(4);
      expect(points.outgoingStartBar + points.overlapBars).toBeGreaterThanOrEqual(180);
    });
  });

  describe('the loop style', () => {
    const SHORT_INTRO = phrases(['intro', 8], ['drop', 64], ['outro', 16]);
    const loopInput = { ...input, style: 'loop' as const, incoming: { phrases: SHORT_INTRO, barCount: 88 } };

    it('holds a short intro on a loop so its drop lands on the swap of a long blend', () => {
      // A blend brings an 8-bar intro's drop in after a quarter of the overlap.
      expect(chooseMixPoints({ ...loopInput, style: 'blend' })).toEqual({
        overlapBars: 32,
        outgoingStartBar: 144,
        incomingStartBar: 0,
        bassSwapBar: 8,
      });
      // The loop plays the intro twice: the drop lands mid-blend, where the outgoing bass leaves.
      expect(chooseMixPoints(loopInput)).toEqual({
        overlapBars: 32,
        outgoingStartBar: 144,
        incomingStartBar: 0,
        bassSwapBar: 16,
        incomingLoop: { startBar: 0, bars: 8, repeats: 1 },
      });
    });

    it('loops a phrase short of the full energy, before the drop and over by the swap', () => {
      const incoming = phrases(['intro', 8, { kick: false }], ['intro', 8], ['build', 8], ['drop', 64], ['outro', 16]);
      for (const timing of ['end', 'now'] as const) {
        const points = chooseMixPoints({ ...loopInput, timing, incoming: { phrases: incoming, barCount: 104 } });
        const loop = points.incomingLoop!;
        expect(loop.startBar + loop.bars).toBeLessThanOrEqual(24);
        expect(points.incomingStartBar).toBeLessThanOrEqual(loop.startBar);
        expect(loop.startBar + loop.bars * (loop.repeats + 1)).toBeLessThanOrEqual(points.incomingStartBar + points.bassSwapBar);
      }
    });

    it('holds a pad intro without a kick: the outgoing track carries the beat until the swap', () => {
      const pads = phrases(['intro', 8, { kick: false, bass: false }], ['drop', 64], ['outro', 16]);
      const points = chooseMixPoints({ ...loopInput, incoming: { phrases: pads, barCount: 88 } });
      expect(points.incomingLoop).toEqual({ startBar: 0, bars: 8, repeats: 1 });
      expect(points.incomingStartBar + points.bassSwapBar).toBe(16);
    });

    it('loops a 4-bar intro before the phrase grid so its drop lands a whole number of phrases in', () => {
      const short = phrases(['intro', 4], ['drop', 64], ['outro', 16]);
      const points = chooseMixPoints({ ...loopInput, incoming: { phrases: short, barCount: 84 } });
      const loop = points.incomingLoop!;
      expect(loop).toMatchObject({ startBar: 0, bars: 4 });
      // The drop (track bar 4) comes after the repeats, on a phrase line of the overlap: the swap.
      const dropInOverlap = 4 + loop.repeats * loop.bars - points.incomingStartBar;
      expect(dropInOverlap % 8).toBe(0);
      expect(points.bassSwapBar).toBe(dropInOverlap);
    });

    it("doesn't hold a fade-in or near-silence", () => {
      const fadeIn = phrases(['intro', 8, { kick: false, bass: false, energyDb: -40 }], ['drop', 64], ['outro', 16]);
      expect(chooseMixPoints({ ...loopInput, incoming: { phrases: fadeIn, barCount: 88 } }).incomingLoop).toBeUndefined();
    });

    it('never loops the incoming track for a blend, nor one without a sparse intro', () => {
      expect(chooseMixPoints(input).incomingLoop).toBeUndefined();
      const startsOnDrop = phrases(['drop', 120], ['outro', 8]);
      expect(chooseMixPoints({ ...loopInput, incoming: { phrases: startsOnDrop, barCount: 128 } }).incomingLoop).toBeUndefined();
    });

    it('loops the outgoing track when that makes the blend better, not only when it is short', () => {
      // A track that starts on its drop: the outgoing outro is looped once to reach its natural
      // swap (where its bass leaves) with a 32-bar blend.
      const startsOnDrop = { phrases: phrases(['drop', 120], ['outro', 8]), barCount: 128 };
      expect(chooseMixPoints({ ...input, incoming: startsOnDrop }).outgoingLoop).toBeUndefined();
      const points = chooseMixPoints({ ...loopInput, incoming: startsOnDrop });
      expect(points.outgoingLoop).toEqual({ startBar: 168, bars: 8 });
      expect(points.overlapBars).toBe(32);
      expect(points.outgoingStartBar + points.bassSwapBar).toBe(160);
    });
  });
});
