import type { AudioAnalysis, BarEnergies } from '../analysis/types';
import { loudnessTrimDb } from '../engine/curves';
import { loopedTrackBar, type OutgoingLoop } from './mixPoints';
import type { TransitionPlan } from './planner';
import { type Lane, type LaneControl, type LaneTarget, laneValueAt } from './templates';

/**
 * Energy-aware EQ balance. The blend template says who owns which band when; it cannot know
 * how loud each track's bands are. This module forecasts both decks' per-band level through
 * the overlap (analysed bar energies + loudness trim + the template's EQ and fader gains) and
 * corrects the EQ lanes bar by bar so that each band's sum never rises above what the louder
 * track alone would play there, and the low end hands over at one level. Cuts only, above
 * unity: the trim sets how loud a track is, the balance only keeps two tracks from stacking.
 */

export type Band = 'low' | 'mid' | 'high';
export const BANDS: readonly Band[] = ['low', 'mid', 'high'];

export interface BalanceDeck {
  bars: BarEnergies;
  /** Track bar playing when the overlap starts (outgoing bars count along the loop). */
  startBar: number;
  /** Loudness trim the deck plays with, dB. */
  trimDb: number;
  loop?: OutgoingLoop;
}

export interface BalanceInput {
  overlapBars: number;
  bassSwapBar: number;
  outgoing: BalanceDeck;
  incoming: BalanceDeck;
}

/** Per band, one value per overlap bar (index = bar, 0 … overlapBars), dB. */
export interface BandForecast {
  /** Level the band's sum is held to. */
  reference: number[];
  /** Sum of both decks with the template's gains. */
  template: number[];
  /** Sum with the balanced gains. */
  balanced: number[];
}

export interface BalanceReport {
  bands: Record<Band, BandForecast>;
  /** Each deck's content level per band and overlap bar (dB, trimmed, smoothed), before any gain. */
  levels: Record<LaneTarget, Record<Band, number[]>>;
  /** Largest amount (dB) by which a band's template sum rises above its reference, inner bars. */
  templateExcessDb: number;
  /** The same after balancing: what is left for the ear. */
  balancedExcessDb: number;
}

/** Bars on either side of the overlap that set the reference levels. */
const REFERENCE_BARS = 8;
/** Sums within this of the reference are left alone. */
const TOLERANCE_DB = 1;
/** A band is lifted at most this far above the template (and never above unity)… */
const MAX_BOOST_DB = 3;
/**
 * …except the incoming low band from the swap on, which may be lifted this far above its
 * template, unity or not: a bass that arrives quieter than the one it replaces is pushed to
 * meet it, then released to its own level by the end of the blend (what a DJ does with the
 * low knob on a weaker bass).
 */
const MAX_LOW_LIFT_DB = 4;
/** Bars before the swap whose outgoing level the low band's handover walk starts from. */
const SWAP_LEVEL_BARS = 2;
/** …and cut to no lower than this (kills stay kills). */
const FLOOR_DB = -24;
/** The incoming deck's corrections fade out over its last bars, so it leaves the blend at unity. */
const RELEASE_BARS = 4;
/** A correction comes off no faster than this per bar; cuts may deepen at once. */
const RELEASE_SLEW_DB = 2;
/** Bar levels are smoothed over this many bars: the balance follows sections, not single bars. */
const SMOOTHING_BARS = 3;
const SILENCE_DB = -120;

/**
 * The plan's lanes with the EQ balanced for these two tracks. Cuts and the plan untouched
 * when it isn't a blend.
 */
export function balancePlan(plan: TransitionPlan, outgoing: AudioAnalysis, incoming: AudioAnalysis): TransitionPlan {
  if (plan.kind !== 'blend' || plan.overlapBars <= 0) return plan;
  const { lanes, report } = balanceLanes(plan.lanes, {
    overlapBars: plan.overlapBars,
    bassSwapBar: plan.bassSwapBar,
    outgoing: {
      bars: outgoing.bars,
      startBar: plan.outgoingStartBar,
      trimDb: loudnessTrimDb(outgoing.loudness.integratedLufs),
      loop: plan.outgoingLoop,
    },
    incoming: {
      bars: incoming.bars,
      startBar: plan.incomingStartBar,
      trimDb: loudnessTrimDb(incoming.loudness.integratedLufs),
    },
  });
  return { ...plan, lanes, balance: report };
}

/**
 * Balances a lane set. Per band and bar the sum of both decks is forecast with the template's
 * gains and held to a reference: the louder of a walk (from the outgoing track's pre-overlap
 * level to the incoming track's post-overlap level) and the lead deck alone (the outgoing
 * until the swap, the incoming after), so the lead's own dynamics are never flattened while
 * the other deck fits under the walk and the two never stack. The low band follows the walk
 * from the swap on — the outgoing level, then easing to the incoming level — so the bass hands
 * over without a step. Excess is cut from both decks alike (the template's balance between
 * them is kept); when the incoming deck is releasing its corrections, the outgoing takes up
 * the difference.
 */
export function balanceLanes(lanes: Lane[], input: BalanceInput): { lanes: Lane[]; report: BalanceReport } {
  const n = input.overlapBars;
  const swap = input.bassSwapBar;
  const out = deckSeries(input.outgoing, 'outgoing', n);
  const inc = deckSeries(input.incoming, 'incoming', n);
  const corrections: Record<LaneTarget, Record<Band, number[]>> = {
    outgoing: { low: [], mid: [], high: [] },
    incoming: { low: [], mid: [], high: [] },
  };
  const bands = {} as Record<Band, BandForecast>;
  let templateExcessDb = 0;
  let balancedExcessDb = 0;

  for (const band of BANDS) {
    const bars: { pOut: number; pIn: number; target: number; eqOut: number; eqIn: number }[] = [];
    const cOut: number[] = [];
    const cIn: number[] = [];
    // The level the ear has just heard when the bass swaps: the outgoing's, right before it.
    const swapLevel = recentLevel(out.level[band], swap, out.reference[band]);
    for (let b = 0; b <= n; b++) {
      const tOut = gainsAt(lanes, 'outgoing', band, b);
      const tIn = gainsAt(lanes, 'incoming', band, b);
      const pOut = toPower(out.level[band][b] + tOut.total);
      const pIn = toPower(inc.level[band][b] + tIn.total);
      // Until the bass swap the blend is the outgoing track as it plays: the sum may be as
      // loud as it alone, so it is never cut for the other deck being quiet and the incoming
      // fits under it. From the swap on the blend walks from the outgoing's level there to
      // the incoming track's own level; the incoming (now the lead) keeps its own dynamics
      // above the walk, except in the low band, which follows the walk so the bass hands
      // over at one level and eases to its own.
      const walk = b < swap ? out.level[band][b] : mixDb(swapLevel, inc.reference[band], (b - swap) / Math.max(1, n - swap));
      const lead = b < swap ? pOut : pIn;
      const target = band === 'low' && b >= swap ? toPower(walk) : Math.max(toPower(walk), lead);
      bars.push({ pOut, pIn, target, eqOut: tOut.eq, eqIn: tIn.eq });

      let common = 0;
      const sum = pOut + pIn;
      if (target > 0 && sum > 0) {
        const excess = toDb(sum) - toDb(target);
        if (excess > TOLERANCE_DB) common = -(excess - TOLERANCE_DB);
        else if (excess < -TOLERANCE_DB) common = Math.min(MAX_BOOST_DB, -excess - TOLERANCE_DB);
      }
      cIn.push(clampCorrection(common, tIn.eq, band === 'low' && b >= swap ? MAX_LOW_LIFT_DB : undefined));
      cOut.push(b === 0 ? 0 : clampCorrection(common, tOut.eq));
    }

    // Corrections come off gradually (a cut may deepen at once, so nothing stacks), the
    // incoming deck's fade out entirely over its last bars, and where that leaves too much the
    // outgoing deck gives way.
    slewRelease(cOut);
    slewRelease(cIn);
    for (let b = 0; b <= n; b++) cIn[b] *= Math.max(0, Math.min(1, (n - b) / RELEASE_BARS));
    for (let b = 1; b <= n; b++) {
      const { pOut, pIn, target, eqOut } = bars[b];
      if (target <= 0 || pOut <= 0) continue;
      const withIn = pIn * toPower(cIn[b]);
      if (toDb(withIn + pOut * toPower(cOut[b])) - toDb(target) > TOLERANCE_DB) {
        const room = target * toPower(TOLERANCE_DB) - withIn;
        cOut[b] = room > 0 ? clampCorrection(toDb(room / pOut), eqOut) : clampCorrection(-Infinity, eqOut);
      }
    }
    corrections.outgoing[band] = cOut;
    corrections.incoming[band] = cIn;

    const forecast: BandForecast = { reference: [], template: [], balanced: [] };
    bars.forEach(({ pOut, pIn, target }, b) => {
      const reference = toDb(target);
      const template = toDb(pOut + pIn);
      const balanced = toDb(pOut * toPower(cOut[b]) + pIn * toPower(cIn[b]));
      forecast.reference.push(reference);
      forecast.template.push(template);
      forecast.balanced.push(balanced);
      if (b > 0 && b < n && target > 0) {
        templateExcessDb = Math.max(templateExcessDb, template - reference);
        balancedExcessDb = Math.max(balancedExcessDb, balanced - reference);
      }
    });
    bands[band] = forecast;
  }

  return {
    lanes: applyCorrections(lanes, corrections, n),
    report: {
      bands,
      levels: { outgoing: out.level, incoming: inc.level },
      templateExcessDb: round2(templateExcessDb),
      balancedExcessDb: round2(balancedExcessDb),
    },
  };
}

interface DeckSeries {
  /** Per band, the deck's content level (dB, trimmed, smoothed) at each overlap bar 0 … n. */
  level: Record<Band, number[]>;
  /** Per band, the deck's level just outside the overlap (before it: outgoing; after: incoming). */
  reference: Record<Band, number>;
}

function deckSeries(deck: BalanceDeck, target: LaneTarget, n: number): DeckSeries {
  const level = {} as Record<Band, number[]>;
  const reference = {} as Record<Band, number>;
  for (const band of BANDS) {
    const raw: number[] = [];
    for (let b = 0; b <= n; b++) raw.push(contentDb(deck, target, band, b));
    level[band] = smooth(raw);
    const window =
      target === 'outgoing'
        ? { from: -REFERENCE_BARS, to: 0, fallbackFrom: 0, fallbackTo: Math.min(REFERENCE_BARS, n) }
        : { from: n, to: n + REFERENCE_BARS, fallbackFrom: Math.max(0, n - REFERENCE_BARS), fallbackTo: n };
    reference[band] = referenceDb(deck, target, band, window);
  }
  return { level, reference };
}

/** The deck's band level (dB, with its trim) at an overlap bar; silence past either end of the track. */
function contentDb(deck: BalanceDeck, target: LaneTarget, band: Band, bar: number): number {
  const own = deck.startBar + bar;
  const trackBar = target === 'outgoing' ? loopedTrackBar(deck.loop, own) : own;
  const values = deck.bars[`${band}Db`];
  if (trackBar < 0 || trackBar >= values.length) return SILENCE_DB;
  return values[trackBar] + deck.trimDb;
}

/** Power mean of the deck's level over a window of overlap bars (a fallback window when it is empty). */
function referenceDb(
  deck: BalanceDeck,
  target: LaneTarget,
  band: Band,
  window: { from: number; to: number; fallbackFrom: number; fallbackTo: number },
): number {
  const levels = (from: number, to: number) => {
    const out: number[] = [];
    for (let bar = from; bar < to; bar++) {
      const db = contentDb(deck, target, band, bar);
      if (db > SILENCE_DB) out.push(db);
    }
    return out;
  };
  let values = levels(window.from, window.to);
  if (values.length === 0) values = levels(window.fallbackFrom, window.fallbackTo);
  if (values.length === 0) return SILENCE_DB;
  return toDb(values.reduce((sum, db) => sum + toPower(db), 0) / values.length);
}

/** Centred moving average in dB over the bars that have sound; silent bars stay silent. */
function smooth(values: number[]): number[] {
  const half = Math.floor(SMOOTHING_BARS / 2);
  return values.map((value, i) => {
    if (value <= SILENCE_DB) return value;
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      if (values[j] > SILENCE_DB) {
        sum += values[j];
        count++;
      }
    }
    return sum / count;
  });
}

interface Gains {
  /** The template's EQ value for the band, dB (−Infinity = kill). */
  eq: number;
  /** EQ plus the channel fader, dB. */
  total: number;
}

function laneOf(lanes: Lane[], target: LaneTarget, control: LaneControl): Lane | undefined {
  return lanes.find((lane) => lane.target === target && lane.control === control);
}

function gainsAt(lanes: Lane[], target: LaneTarget, band: Band, bar: number): Gains {
  const eqLane = laneOf(lanes, target, band);
  const eq = eqLane ? laneValueAt(eqLane, bar) : 0;
  const faderLane = laneOf(lanes, target, 'fader');
  const fader = faderLane ? laneValueAt(faderLane, bar) : 1;
  return { eq, total: eq + (fader > 0 ? 20 * Math.log10(fader) : -Infinity) };
}

/**
 * In place: a correction moves back towards 0 by at most RELEASE_SLEW_DB per bar (a cut
 * deepening, or a boost growing, is immediate). What was a step becomes a short ramp.
 */
function slewRelease(series: number[]): void {
  for (let b = 1; b < series.length; b++) {
    const previous = series[b - 1];
    const next = series[b];
    if (previous < 0 && next > previous) series[b] = Math.min(next, previous + RELEASE_SLEW_DB);
    else if (previous > 0 && next < previous) series[b] = Math.max(next, previous - RELEASE_SLEW_DB);
  }
}

/**
 * A correction on a template value: never above unity or +MAX_BOOST (or, with `lift`, no
 * higher than that above the template), never below the floor. Kills, and bands the template
 * already has below the floor, are left as they are.
 */
function clampCorrection(correction: number, templateDb: number, lift?: number): number {
  if (!Number.isFinite(templateDb) || templateDb <= FLOOR_DB) return 0;
  const high = lift !== undefined ? lift : Math.max(0, Math.min(MAX_BOOST_DB, -templateDb));
  const low = Math.min(0, FLOOR_DB - templateDb);
  return Math.max(low, Math.min(high, correction));
}

/** Power mean of the bars just before `bar` that have sound; `fallback` when none have. */
function recentLevel(series: number[], bar: number, fallback: number): number {
  const values = series.slice(Math.max(0, bar - SWAP_LEVEL_BARS), Math.max(0, bar)).filter((db) => db > SILENCE_DB);
  if (values.length === 0) return fallback;
  return toDb(values.reduce((sum, db) => sum + toPower(db), 0) / values.length);
}

/**
 * The lanes with the corrections folded in: EQ lanes get a point on every bar (template value
 * plus correction); the template's own points stay (kills, the swap edges, fractional bars),
 * corrected by the correction interpolated at their bar. Fader and filter lanes are unchanged.
 */
function applyCorrections(
  lanes: Lane[],
  corrections: Record<LaneTarget, Record<Band, number[]>>,
  n: number,
): Lane[] {
  const result: Lane[] = [];
  const done = new Set<string>();
  const correctionAt = (series: number[], bar: number) => {
    const i = Math.max(0, Math.min(n - 1, Math.floor(bar)));
    const t = Math.max(0, Math.min(1, bar - i));
    return series[i] + (series[Math.min(n, i + 1)] - series[i]) * t;
  };

  for (const lane of lanes) {
    if (lane.control === 'fader' || lane.control === 'filter') {
      result.push(lane);
      continue;
    }
    const series = corrections[lane.target][lane.control];
    done.add(`${lane.target}/${lane.control}`);
    if (series.every((c) => c === 0)) {
      result.push(lane);
      continue;
    }
    const points = new Map<number, number>();
    for (let b = 0; b <= n; b++) {
      const value = laneValueAt(lane, b);
      if (Number.isFinite(value)) points.set(b, value + series[b]);
    }
    for (const point of lane.points) {
      if (!Number.isFinite(point.value)) points.set(point.bar, point.value);
      else if (!points.has(point.bar)) points.set(point.bar, point.value + correctionAt(series, point.bar));
    }
    result.push({
      ...lane,
      points: [...points.entries()].sort((a, b) => a[0] - b[0]).map(([bar, value]) => ({ bar, value })),
    });
  }

  // Bands the template leaves at unity still get a lane when they need correcting.
  for (const target of ['outgoing', 'incoming'] as const) {
    for (const band of BANDS) {
      if (done.has(`${target}/${band}`)) continue;
      const series = corrections[target][band];
      if (series.every((c) => c === 0)) continue;
      result.push({ target, control: band, shape: 'linear', points: series.map((value, bar) => ({ bar, value })) });
    }
  }
  return result;
}

function toPower(db: number): number {
  return Number.isFinite(db) && db > SILENCE_DB ? Math.pow(10, db / 10) : 0;
}

function toDb(power: number): number {
  return power > 0 ? 10 * Math.log10(power) : -Infinity;
}

/** Linear walk in dB from `a` to `b`; silence on one side jumps at the half-way point. */
function mixDb(a: number, b: number, t: number): number {
  if (a <= SILENCE_DB || b <= SILENCE_DB) return t < 0.5 ? a : b;
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
