import { describe, expect, it } from 'vitest';
import type { BarEnergies } from '../analysis/types';
import { balanceLanes, BANDS, type BalanceDeck, type Band } from './balance';
import { blendTemplate, KILL, type Lane, laneValueAt } from './templates';

/** `count` bars at steady band levels (dB); `sections` overrides ranges of bars. */
function energies(
  count: number,
  levels: Record<Band, number>,
  sections: { from: number; to: number; levels: Partial<Record<Band, number>> }[] = [],
): BarEnergies {
  const bars: BarEnergies = { lowDb: [], midDb: [], highDb: [], bassDb: [] };
  for (let bar = 0; bar < count; bar++) {
    const here = { ...levels };
    for (const section of sections) if (bar >= section.from && bar < section.to) Object.assign(here, section.levels);
    bars.lowDb.push(here.low);
    bars.midDb.push(here.mid);
    bars.highDb.push(here.high);
    bars.bassDb.push(here.low);
  }
  return bars;
}

const STEADY: Record<Band, number> = { low: -12, mid: -18, high: -24 };

function deck(bars: BarEnergies, startBar: number, extra: Partial<BalanceDeck> = {}): BalanceDeck {
  return { bars, startBar, trimDb: 0, ...extra };
}

function lane(lanes: Lane[], target: Lane['target'], control: Lane['control']): Lane {
  const found = lanes.find((l) => l.target === target && l.control === control);
  if (!found) throw new Error(`no ${target} ${control} lane`);
  return found;
}

describe('balanceLanes', () => {
  const overlap = 32;
  const swap = 16;
  const template = blendTemplate(overlap, swap);

  it('keeps two equal tracks from stacking: no band rises more than a dB above one track alone', () => {
    const outgoing = deck(energies(128, STEADY), 80);
    const incoming = deck(energies(128, STEADY), 16);
    const { report } = balanceLanes(template, { overlapBars: overlap, bassSwapBar: swap, outgoing, incoming });

    // The template alone lets the mids of both tracks play near full together for a while.
    expect(report.templateExcessDb).toBeGreaterThan(1);
    expect(report.balancedExcessDb).toBeLessThanOrEqual(1.05);
    expect(report.balancedExcessDb).toBeLessThan(report.templateExcessDb);
    for (const band of BANDS) {
      const { reference, balanced } = report.bands[band];
      for (let bar = 1; bar < overlap; bar++) expect(balanced[bar] - reference[bar]).toBeLessThanOrEqual(1.05);
    }
  });

  it('never cuts the outgoing track for the incoming one being quiet', () => {
    const outgoing = deck(energies(128, STEADY), 80);
    const incoming = deck(energies(128, { low: -40, mid: -40, high: -40 }), 16);
    const { lanes } = balanceLanes(template, { overlapBars: overlap, bassSwapBar: swap, outgoing, incoming });
    // Before the swap nothing stacks: the outgoing lanes are at least what the template wrote
    // (the highs may be held up a little where the template lowers them and nothing replaces
    // them), and never above unity.
    for (const band of ['mid', 'high'] as const) {
      const original = lane(template, 'outgoing', band);
      const balanced = lane(lanes, 'outgoing', band);
      for (let bar = 0; bar <= swap; bar++) {
        expect(laneValueAt(balanced, bar)).toBeGreaterThanOrEqual(laneValueAt(original, bar) - 1e-9);
        expect(laneValueAt(balanced, bar)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('holds an incoming track with 10 dB hotter hats under the walk, and releases it to unity by the end', () => {
    const outgoing = deck(energies(128, STEADY), 80);
    const incoming = deck(energies(128, { ...STEADY, high: STEADY.high + 10 }), 16);
    const { lanes, report } = balanceLanes(template, { overlapBars: overlap, bassSwapBar: swap, outgoing, incoming });

    const high = lane(lanes, 'incoming', 'high');
    const templateHigh = lane(template, 'incoming', 'high');
    // The template opens the incoming highs fully a quarter in; the hot hats would stack on the
    // outgoing ones, so they are held back…
    for (const at of [10, 12, 14]) expect(laneValueAt(high, at)).toBeLessThan(laneValueAt(templateHigh, at) - 1);
    // …the outgoing highs give way at the same time (the template's balance between the decks is kept)…
    expect(laneValueAt(lane(lanes, 'outgoing', 'high'), 12)).toBeLessThan(laneValueAt(lane(template, 'outgoing', 'high'), 12) - 1);
    // …no band sum exceeds its reference by more than the tolerance…
    expect(report.balancedExcessDb).toBeLessThanOrEqual(1.05);
    expect(report.templateExcessDb).toBeGreaterThan(2);
    // …and the incoming deck leaves the blend at unity, as the template does.
    for (const band of BANDS) expect(laneValueAt(lane(lanes, 'incoming', band), overlap)).toBe(0);
  });

  it('matches the bass handover: a hotter incoming low end enters at the outgoing level', () => {
    const outgoing = deck(energies(128, STEADY), 80);
    const incoming = deck(energies(128, { ...STEADY, low: STEADY.low + 4 }), 16);
    const { lanes } = balanceLanes(template, { overlapBars: overlap, bassSwapBar: swap, outgoing, incoming });

    const low = lane(lanes, 'incoming', 'low');
    // Killed until the swap. There the incoming bass is 4 dB hotter but its fader is still
    // 1.25 dB short of full, so it is cut by about 1.75 dB (the tolerance stays); the cut eases
    // to 0 by the end as the reference walks up to the incoming track's own level.
    expect(laneValueAt(low, swap - 1)).toBe(KILL);
    expect(laneValueAt(low, swap)).toBeLessThan(-1);
    expect(laneValueAt(low, swap)).toBeGreaterThan(-3);
    for (let bar = swap; bar <= overlap; bar++) expect(laneValueAt(low, bar)).toBeLessThanOrEqual(0);
    expect(laneValueAt(low, overlap)).toBe(0);
    expect(laneValueAt(low, overlap - 2)).toBeGreaterThan(laneValueAt(low, swap + 2));
    // The outgoing low end still leaves exactly on the swap.
    const outLow = lane(lanes, 'outgoing', 'low');
    expect(laneValueAt(outLow, swap - 1)).toBeCloseTo(0, 6);
    expect(laneValueAt(outLow, swap)).toBe(KILL);
    expect(laneValueAt(outLow, swap + 1)).toBe(KILL);
  });

  it('never boosts a band above unity, even when both tracks are quiet', () => {
    const outgoing = deck(energies(128, STEADY, [{ from: 80, to: 128, levels: { mid: -30, high: -36 } }]), 80);
    const incoming = deck(energies(128, STEADY, [{ from: 0, to: 48, levels: { mid: -30, high: -36 } }]), 16);
    const { lanes } = balanceLanes(template, { overlapBars: overlap, bassSwapBar: swap, outgoing, incoming });
    for (const l of lanes) {
      if (l.control === 'fader' || l.control === 'filter') continue;
      for (const point of l.points) expect(point.value).toBeLessThanOrEqual(0);
    }
  });

  it('starts the outgoing deck from unity, so nothing jumps when the overlap begins', () => {
    const outgoing = deck(energies(128, STEADY, [{ from: 80, to: 128, levels: { low: -6, mid: -12, high: -18 } }]), 80);
    const incoming = deck(energies(128, STEADY), 16);
    const { lanes } = balanceLanes(template, { overlapBars: overlap, bassSwapBar: swap, outgoing, incoming });
    for (const band of BANDS) {
      const l = lane(lanes, 'outgoing', band);
      // The lane holds its first value until its first point: that value is unity.
      expect(l.points[0].value).toBe(0);
      expect(laneValueAt(l, 0)).toBe(0);
    }
  });

  it('reads the outgoing track along its loop and treats bars past either end as silence', () => {
    // Bars 8–15 are loud, the rest quiet; the overlap starts at bar 8 and loops that phrase.
    const quiet = { low: -30, mid: -36, high: -42 };
    const outgoing = deck(energies(24, quiet, [{ from: 8, to: 16, levels: STEADY }]), 8, {
      loop: { startBar: 8, bars: 8 },
    });
    const incoming = deck(energies(4, STEADY), 60);
    const { report, lanes } = balanceLanes(blendTemplate(16, 8), {
      overlapBars: 16,
      bassSwapBar: 8,
      outgoing,
      incoming,
    });
    // The looped bars read as loud as the first pass; the incoming track, past its end, is silent.
    expect(report.levels.outgoing.mid[12]).toBeCloseTo(report.levels.outgoing.mid[4], 6);
    expect(report.levels.outgoing.mid[4]).toBeCloseTo(STEADY.mid, 6);
    for (const band of BANDS) for (const level of report.levels.incoming[band]) expect(level).toBeLessThanOrEqual(-120);
    for (const l of lanes) {
      for (const point of l.points) expect(Number.isNaN(point.value)).toBe(false);
      for (let i = 1; i < l.points.length; i++) expect(l.points[i].bar).toBeGreaterThan(l.points[i - 1].bar);
    }
  });

  it('keeps the template points, including fractional bars, and adds one per bar', () => {
    const odd = blendTemplate(18, 9);
    const outgoing = deck(energies(128, STEADY), 80);
    const incoming = deck(energies(128, { ...STEADY, high: STEADY.high + 6 }), 16);
    const { lanes } = balanceLanes(odd, { overlapBars: 18, bassSwapBar: 9, outgoing, incoming });
    const high = lane(lanes, 'incoming', 'high');
    const bars = high.points.map((p) => p.bar);
    expect(bars).toContain(4.5);
    for (let bar = 0; bar <= 18; bar++) expect(bars).toContain(bar);
  });
});
