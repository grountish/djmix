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
