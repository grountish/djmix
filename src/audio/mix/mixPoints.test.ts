import { describe, expect, it } from 'vitest';
import type { Phrase, PhraseLabel } from '../analysis/types';
import { chooseMixPoints } from './mixPoints';

function phrases(...sections: [PhraseLabel, number][]): Phrase[] {
  let startBar = 0;
  return sections.map(([label, bars]) => {
    const phrase = { startBar, bars, label, hasKick: true, hasBass: label === 'drop', energyDb: -10 };
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
});
