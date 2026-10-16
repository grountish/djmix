import { toCamelot, type MusicalKey } from '../analysis/key';

/**
 * How well two keys mix (0–1), on the Camelot wheel: same key, a fifth either way or the
 * relative major/minor sit well; two steps up (a tone) and seven steps (a semitone up) are
 * the classic energy lifts.
 */
export function harmonicScore(from: MusicalKey, to: MusicalKey): number {
  const a = toCamelot(from);
  const b = toCamelot(to);
  if (a === b) return 1;
  const steps = (((parseInt(b) - parseInt(a)) % 12) + 12) % 12;
  const sameLetter = a.slice(-1) === b.slice(-1);
  if (steps === 0) return 0.9; // relative major/minor
  if (!sameLetter) return 0;
  if (steps === 1 || steps === 11) return 0.9;
  if (steps === 2) return 0.6;
  if (steps === 7) return 0.5;
  return 0;
}

export function transpose(key: MusicalKey, semitones: number): MusicalKey {
  return { tonic: (((key.tonic + semitones) % 12) + 12) % 12, mode: key.mode };
}

/** Pitch shift heard when a deck plays at `rate` without key lock (semitones, fractional). */
export function rateShiftSemitones(rate: number): number {
  return 12 * Math.log2(rate);
}

/**
 * Whole-semitone shift (within ±maxShift) of the incoming key that mixes best with the
 * outgoing one. No shift wins ties, and a shift must beat it by a clear margin.
 */
export function bestKeyShift(
  outgoing: MusicalKey,
  incoming: MusicalKey,
  maxShift = 1,
): { semitones: number; score: number } {
  let best = { semitones: 0, score: harmonicScore(outgoing, incoming) };
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    if (shift === 0) continue;
    const score = harmonicScore(outgoing, transpose(incoming, shift));
    if (score > best.score + 0.2) best = { semitones: shift, score };
  }
  return best;
}
