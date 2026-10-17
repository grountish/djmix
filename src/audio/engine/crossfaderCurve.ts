import { clamp, crossfaderGains } from './curves';

/**
 * - smooth: both decks full in the centre, the far deck fades along a quarter cosine
 *   (the blend law automix relies on).
 * - sharp: a cut curve for scratching: the far deck stays full until the last stretch of
 *   travel and drops there.
 * - linear: a straight fade from the centre to either end.
 */
export type CrossfaderCurve = 'smooth' | 'sharp' | 'linear';

export interface CrossfaderSettings {
  curve: CrossfaderCurve;
  /** Hamster switch: left is deck B, right is deck A. */
  reverse: boolean;
}

export const DEFAULT_CROSSFADER: CrossfaderSettings = { curve: 'smooth', reverse: false };

export const CROSSFADER_CURVES: { curve: CrossfaderCurve; label: string }[] = [
  { curve: 'smooth', label: 'Smooth' },
  { curve: 'sharp', label: 'Sharp' },
  { curve: 'linear', label: 'Linear' },
];

/** Share of the travel at either end over which the sharp curve fades the far deck. */
const SHARP_FADE = 0.08;

/** Gains of decks A and B for a crossfader `position` (-1 full A … 1 full B) on a curve. */
export function crossfaderGainsFor(
  settings: CrossfaderSettings,
  position: number,
): { a: number; b: number } {
  const x = clamp(settings.reverse ? -position : position, -1, 1);
  switch (settings.curve) {
    case 'sharp':
      return { a: sharpGain(x), b: sharpGain(-x) };
    case 'linear':
      return { a: x <= 0 ? 1 : 1 - x, b: x >= 0 ? 1 : 1 + x };
    default:
      return crossfaderGains(x);
  }
}

/** Gain of the deck on the left for a position `x`: full until the far end's fade zone. */
function sharpGain(x: number): number {
  const fadeStart = 1 - SHARP_FADE;
  if (x <= fadeStart) return 1;
  return Math.cos(((x - fadeStart) / SHARP_FADE) * (Math.PI / 2));
}
