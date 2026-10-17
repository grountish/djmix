export type LaneTarget = 'outgoing' | 'incoming';
export type LaneControl = 'fader' | 'low' | 'mid' | 'high' | 'filter';

/**
 * One automated control over the transition. Bars are counted from the start of the overlap
 * (negative = before it). Values: fader gain 0–1, EQ in dB (-Infinity = kill), filter knob
 * -1…1. Between two points the value moves along `shape`; it holds after the last one.
 */
export interface Lane {
  target: LaneTarget;
  control: LaneControl;
  points: { bar: number; value: number }[];
  /** 'rise' / 'fall': quarter-sine fades (equal power); 'linear' in dB for EQ, else linear. */
  shape: 'linear' | 'rise' | 'fall';
}

export const KILL = -Infinity;

/** Duration of the bass handover (half a beat), ending exactly on the swap downbeat. */
const BASS_SWAP_BARS = 1 / 8;
/** Filter knob position the outgoing track is swept to (high-pass around 500 Hz). */
const OUTRO_HIGHPASS = 0.55;

/**
 * EQ blend around the bass swap. Incoming highs and mids are eased in first; the basslines
 * swap in half a beat right before the swap downbeat, so exactly one deck owns the low end
 * at any time; then the outgoing mids and highs give way and its remainder is filtered and
 * faded out over most of what is left. On a key clash the incoming mids stay out until the
 * swap.
 */
export function blendTemplate(overlapBars: number, bassSwapBar: number, keyClash: boolean): Lane[] {
  const length = overlapBars;
  const swap = bassSwapBar;
  const after = length - swap;
  const fadeIn = Math.min(length / 4, swap / 2);
  const incomingMid = keyClash
    ? [
        { bar: 0, value: KILL },
        { bar: swap - BASS_SWAP_BARS, value: KILL },
        { bar: swap + after / 2, value: 0 },
      ]
    : [
        { bar: 0, value: -9 },
        { bar: swap / 2, value: -9 },
        { bar: swap, value: -4 },
        { bar: swap + after / 4, value: 0 },
      ];

  return [
    { target: 'incoming', control: 'fader', shape: 'rise', points: [{ bar: 0, value: 0 }, { bar: fadeIn, value: 1 }] },
    { target: 'incoming', control: 'high', shape: 'linear', points: [{ bar: 0, value: -6 }, { bar: length / 4, value: 0 }] },
    { target: 'incoming', control: 'mid', shape: 'linear', points: incomingMid },
    {
      target: 'incoming',
      control: 'low',
      shape: 'linear',
      points: [
        { bar: 0, value: KILL },
        { bar: swap - BASS_SWAP_BARS, value: KILL },
        { bar: swap, value: 0 },
      ],
    },
    {
      target: 'outgoing',
      control: 'low',
      shape: 'linear',
      points: [
        { bar: swap - BASS_SWAP_BARS, value: 0 },
        { bar: swap, value: KILL },
      ],
    },
    {
      target: 'outgoing',
      control: 'high',
      shape: 'linear',
      points: [{ bar: swap / 2, value: 0 }, { bar: swap + after / 2, value: -9 }],
    },
    {
      target: 'outgoing',
      control: 'mid',
      shape: 'linear',
      points: [{ bar: swap, value: 0 }, { bar: swap + (3 * after) / 4, value: -12 }],
    },
    {
      target: 'outgoing',
      control: 'filter',
      shape: 'linear',
      points: [{ bar: swap + after / 2, value: 0 }, { bar: length, value: OUTRO_HIGHPASS }],
    },
    {
      target: 'outgoing',
      control: 'fader',
      shape: 'fall',
      points: [{ bar: swap + after / 4, value: 1 }, { bar: length, value: 0 }],
    },
  ];
}

/**
 * Cut for tracks that can't be blended: the outgoing track is filtered and faded over the
 * two bars before the phrase line, where the incoming track starts at full level.
 */
export function cutTemplate(): Lane[] {
  return [
    { target: 'outgoing', control: 'filter', shape: 'linear', points: [{ bar: -2, value: 0 }, { bar: 0, value: OUTRO_HIGHPASS }] },
    { target: 'outgoing', control: 'fader', shape: 'fall', points: [{ bar: -1, value: 1 }, { bar: 0, value: 0 }] },
  ];
}

/** Value of a lane at `bar`. */
export function laneValueAt(lane: Lane, bar: number): number {
  const { points } = lane;
  if (bar <= points[0].bar) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (bar > b.bar) continue;
    const t = b.bar === a.bar ? 1 : (bar - a.bar) / (b.bar - a.bar);
    return interpolate(lane, a.value, b.value, t);
  }
  return points[points.length - 1].value;
}

const KILL_FLOOR_DB = -60;

export function interpolate(lane: Pick<Lane, 'control' | 'shape'>, from: number, to: number, t: number): number {
  if (lane.shape === 'rise') return from + (to - from) * Math.sin((t * Math.PI) / 2);
  if (lane.shape === 'fall') return to + (from - to) * Math.cos((t * Math.PI) / 2);
  const isEq = lane.control === 'low' || lane.control === 'mid' || lane.control === 'high';
  if (!isEq) return from + (to - from) * t;
  if (t <= 0) return from;
  if (t >= 1) return to;
  // EQ moves in dB; a kill end point is approached through -60 dB and reached exactly.
  const a = Number.isFinite(from) ? from : KILL_FLOOR_DB;
  const b = Number.isFinite(to) ? to : KILL_FLOOR_DB;
  return a + (b - a) * t;
}

/** EQ value in dB to a gain (kill = 0). */
export function eqDbToGain(db: number): number {
  return Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
}
