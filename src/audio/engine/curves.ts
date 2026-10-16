export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Equal-power crossfader law: -1 = full A, 0 = centre (both at -3 dB), 1 = full B.
 * a² + b² = 1 at every position, so uncorrelated material keeps constant loudness through a fade.
 */
export function equalPowerGains(position: number): { a: number; b: number } {
  const t = (clamp(position, -1, 1) + 1) / 2;
  return {
    a: Math.cos((t * Math.PI) / 2),
    b: Math.sin((t * Math.PI) / 2),
  };
}

/** EQ knob: -1 = kill, 0 = unity, +1 = +6 dB. Squared taper below unity. */
export function eqKnobToGain(position: number): number {
  const p = clamp(position, -1, 1);
  if (p <= 0) return (1 + p) * (1 + p);
  return Math.pow(10, (6 * p) / 20);
}

/** Lowest low-pass and highest high-pass cutoff of the filter knob's sweep. */
const FILTER_LOWPASS_MIN_HZ = 150;
const FILTER_HIGHPASS_MAX_HZ = 8000;
const FILTER_HIGHPASS_MIN_HZ = 20;
const FILTER_LOWPASS_MAX_HZ = 20000;

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
