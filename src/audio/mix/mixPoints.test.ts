import { describe, expect, it } from 'vitest';
import type { Phrase, PhraseLabel } from '../analysis/types';
import { chooseMixPoints } from './mixPoints';

type Section = [PhraseLabel, number] | [PhraseLabel, number, { kick?: boolean; bass?: boolean }];

function phrases(...sections: Section[]): Phrase[] {
  let startBar = 0;
  return sections.map(([label, bars, flags]) => {
    const phrase = {
      startBar,
      bars,
      label,
      hasKick: flags?.kick ?? true,
      hasBass: flags?.bass ?? label === 'drop',
      energyDb: -10,
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

  it('enters at a later drop when the first kick section is too short to blend over', () => {
    // A 7-bar kick intro (phrase lines from bar 7), an 8-bar drop, a 48-bar kickless breakdown,
    // then a long drop: a blend over the breakdown would lose the beat and an 8-bar blend is
    // too short, so cue a phrase before the later drop.
    const incoming = phrases(
      ['intro', 7, { kick: true }],
      ['drop', 8],
      ['breakdown', 48, { kick: false, bass: true }],
      ['drop', 64],
      ['outro', 17],
    );
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 144 } });
    expect(points.overlapBars).toBe(32);
    expect(points.incomingStartBar).toBe(55);
    expect(points.bassSwapBar).toBe(8);
  });

  it('brings a track that starts at full energy in with an early swap, not a short blend', () => {
    const incoming = phrases(['drop', 120], ['outro', 8]);
    const points = chooseMixPoints({ ...input, incoming: { phrases: incoming, barCount: 128 } });
    expect(points.overlapBars).toBe(32);
    expect(points.incomingStartBar).toBe(0);
    expect(points.bassSwapBar).toBe(8);
  });
});
