export interface TempoPolicy {
  /** Furthest a track may play from its own tempo, as a ratio (0.1 = ±10%). */
  maxDeviation: number;
  /** Tempo change per bar during ramps (0.005 = 0.5% per bar), slow enough not to be noticed. */
  rampPerBar: number;
  /** Below this gap only the incoming track adjusts. */
  smallGap: number;
}

export const DEFAULT_TEMPO_POLICY: TempoPolicy = {
  maxDeviation: 0.1,
  rampPerBar: 0.005,
  smallGap: 0.02,
};

export interface TempoPlan {
  /** False when the tempos are too far apart to blend; the transition becomes a cut. */
  canBlend: boolean;
  /** Tempo both tracks play at while they overlap. */
  meetBpm: number;
  /** Playback rates (relative to each track's own tempo) during the overlap. */
  outgoingRate: number;
  incomingRate: number;
  /** Bars the outgoing track ramps over, before the overlap, from its current rate. */
  outgoingRampBars: number;
  /** Bars the incoming track ramps over, after the overlap, back to its own tempo. */
  incomingRampBars: number;
}

/**
 * Native-first tempo plan: both tracks meet halfway (geometric mean), each within the allowed
 * deviation, so neither strays far from its own tempo. Small gaps are absorbed by the incoming
 * track alone.
 */
export function planTempo(
  outgoingBpm: number,
  outgoingCurrentRate: number,
  incomingBpm: number,
  policy: TempoPolicy = DEFAULT_TEMPO_POLICY,
): TempoPlan {
  const gap = Math.abs(Math.log(incomingBpm / outgoingBpm));
  const rampBars = (from: number, to: number) =>
    Math.max(0, Math.ceil(Math.abs(Math.log(to / from)) / Math.log(1 + policy.rampPerBar) - 1e-9));

  let meetBpm: number;
  if (gap <= Math.log(1 + policy.smallGap)) {
    meetBpm = outgoingBpm * outgoingCurrentRate;
  } else {
    const low = Math.max(outgoingBpm, incomingBpm) * (1 - policy.maxDeviation);
    const high = Math.min(outgoingBpm, incomingBpm) * (1 + policy.maxDeviation);
    if (low > high) {
      return {
        canBlend: false,
        meetBpm: outgoingBpm * outgoingCurrentRate,
        outgoingRate: outgoingCurrentRate,
        incomingRate: 1,
        outgoingRampBars: 0,
        incomingRampBars: 0,
      };
    }
    meetBpm = Math.min(high, Math.max(low, Math.sqrt(outgoingBpm * incomingBpm)));
  }

  const outgoingRate = meetBpm / outgoingBpm;
  const incomingRate = meetBpm / incomingBpm;
  return {
    canBlend: true,
    meetBpm,
    outgoingRate,
    incomingRate,
    outgoingRampBars: rampBars(outgoingCurrentRate, outgoingRate),
    incomingRampBars: rampBars(incomingRate, 1),
  };
}
