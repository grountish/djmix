export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Loudness every track is trimmed towards; the master limiter catches what's left. */
export const TARGET_LUFS = -11;
const MAX_TRIM_CUT_DB = -12;
const MAX_TRIM_BOOST_DB = 6;

/**
 * Trim (dB) that brings a track of `integratedLufs` to the target, within the trim's range.
 * Unknown loudness means 0 dB. The app, the planner's level forecast and the offline
 * renders all use this one law, so a predicted level is the level that plays.
 */
export function loudnessTrimDb(integratedLufs: number | undefined): number {
  if (integratedLufs === undefined || !Number.isFinite(integratedLufs)) return 0;
  return clamp(TARGET_LUFS - integratedLufs, MAX_TRIM_CUT_DB, MAX_TRIM_BOOST_DB);
}

/**
 * Crossfader law: -1 = full A, 0 = centre, 1 = full B. Both decks play at full level in the
 * centre (automix blends with the channel faders and EQ there); towards a side the other deck
 * fades out along a quarter cosine.
 */
export function crossfaderGains(position: number): { a: number; b: number } {
  const x = clamp(position, -1, 1);
  return {
    a: x <= 0 ? 1 : Math.cos((x * Math.PI) / 2),
    b: x >= 0 ? 1 : Math.cos((-x * Math.PI) / 2),
  };
}

/** EQ knob: -1 = kill, 0 = unity, +1 = +6 dB. Squared taper below unity. */
export function eqKnobToGain(position: number): number {
  const p = clamp(position, -1, 1);
  if (p <= 0) return (1 + p) * (1 + p);
  return Math.pow(10, (6 * p) / 20);
}

/** Inverse of eqKnobToGain: the knob position that gives `gain`. */
export function eqGainToKnob(gain: number): number {
  if (gain <= 0) return -1;
  if (gain <= 1) return Math.sqrt(gain) - 1;
  return clamp((20 * Math.log10(gain)) / 6, 0, 1);
}

/** Lowest low-pass and highest high-pass cutoff of the filter knob's sweep. */
const FILTER_LOWPASS_MIN_HZ = 150;
const FILTER_HIGHPASS_MAX_HZ = 8000;
const FILTER_LOWPASS_MAX_HZ = 20000;
/**
 * Lowest high-pass cutoff of a sweep. The high-pass rests at exactly 0 Hz (a pass-through
 * special case in every implementation) and must only ever JUMP between 0 and this: a biquad
 * at a fraction of a hertz is numerically ill-conditioned — ramping 0 → 20 Hz bursts the low
 * band by 45 dB, gliding towards 0 with setTargetAtTime runs away by 150 dB (both measured
 * offline). The jump itself costs under 2 dB for a moment. See `settleHighpass`.
 */
export const FILTER_HIGHPASS_MIN_HZ = 20;

/**
 * Filter knob: 0 = off, -1 = low-pass swept down to 150 Hz, +1 = high-pass swept up to
 * 8 kHz (exponential, so the sweep sounds even). Off leaves both filters transparent.
 */
export function filterKnobToCutoffs(
  position: number,
  nyquist: number,
): { lowpassHz: number; highpassHz: number } {
  const p = clamp(position, -1, 1);
  if (p < 0) {
    return {
      lowpassHz: FILTER_LOWPASS_MAX_HZ * Math.pow(FILTER_LOWPASS_MIN_HZ / FILTER_LOWPASS_MAX_HZ, -p),
      highpassHz: 0,
    };
  }
  if (p > 0) {
    return {
      lowpassHz: nyquist,
      highpassHz: FILTER_HIGHPASS_MIN_HZ * Math.pow(FILTER_HIGHPASS_MAX_HZ / FILTER_HIGHPASS_MIN_HZ, p),
    };
  }
  return { lowpassHz: nyquist, highpassHz: 0 };
}

/**
 * Moves a high-pass cutoff to `hz` without ever sitting between 0 and the lowest sweep
 * cutoff (see FILTER_HIGHPASS_MIN_HZ): towards 0 it glides down to that cutoff and then
 * snaps to 0; from 0 it snaps to the cutoff and glides on; between cutoffs it glides.
 */
export function settleHighpass(param: AudioParam, hz: number, ctx: BaseAudioContext, timeConstant: number): void {
  const now = ctx.currentTime;
  param.cancelAndHoldAtTime(now);
  if (hz <= 0) {
    if (param.value <= 0) return;
    param.setTargetAtTime(FILTER_HIGHPASS_MIN_HZ, now, timeConstant);
    param.setValueAtTime(0, now + 5 * timeConstant);
    return;
  }
  if (param.value <= 0) param.setValueAtTime(FILTER_HIGHPASS_MIN_HZ, now);
  param.setTargetAtTime(Math.max(FILTER_HIGHPASS_MIN_HZ, hz), now, timeConstant);
}
