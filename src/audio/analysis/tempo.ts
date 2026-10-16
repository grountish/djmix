const MIN_BPM = 60;
const MAX_BPM = 200;
const BPM_STEP = 0.1;

/** Tempo prior: log-normal around 120 BPM, one octave wide. Breaks half/double-time ties. */
const PRIOR_CENTRE_BPM = 120;
const PRIOR_OCTAVES = 1;

/** Weights of the beat-period multiples summed for each tempo candidate. */
const HARMONIC_WEIGHTS = [1, 0.5, 0.25, 0.125];

const NORMALIZED_BPM_MIN = 85;
const NORMALIZED_BPM_MAX = 175;

/** Folds half/double-time readings into the 85–175 BPM octave. */
export function normalizeBpm(bpm: number): number {
  let normalized = bpm;
  while (normalized < NORMALIZED_BPM_MIN && normalized * 2 <= MAX_BPM) normalized *= 2;
  while (normalized > NORMALIZED_BPM_MAX && normalized / 2 >= MIN_BPM) normalized /= 2;
  return normalized;
}

/** Coarse tempo (±0.5%) from the autocorrelation of an onset-strength envelope. */
export function estimateTempo(onset: Float32Array, frameRate: number): number {
  const odf = rectifiedDetrend(onset, Math.round(frameRate));

  const maxLag = Math.ceil((HARMONIC_WEIGHTS.length * 60 * frameRate) / MIN_BPM) + 2;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < odf.length; i++) sum += odf[i] * odf[i + lag];
    ac[lag] = sum;
  }
  if (ac[0] === 0) return PRIOR_CENTRE_BPM;

  const acAt = (lag: number) => {
    const i = Math.floor(lag);
    const frac = lag - i;
    return ac[i] * (1 - frac) + ac[i + 1] * frac;
  };

  let bestBpm = PRIOR_CENTRE_BPM;
  let bestScore = -Infinity;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += BPM_STEP) {
    const period = (60 * frameRate) / bpm;
    let score = 0;
    HARMONIC_WEIGHTS.forEach((weight, m) => {
      score += weight * acAt((m + 1) * period);
    });
    const octaves = Math.log2(bpm / PRIOR_CENTRE_BPM) / PRIOR_OCTAVES;
    score *= Math.exp(-0.5 * octaves * octaves);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return normalizeBpm(bestBpm);
}

/** Subtracts a moving average and keeps the positive part: rhythm without level changes. */
function rectifiedDetrend(x: Float32Array, window: number): Float32Array {
  const out = new Float32Array(x.length);
  const half = Math.max(1, Math.floor(window / 2));
  let sum = 0;
  let count = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i++) {
    while (hi < Math.min(x.length - 1, i + half)) sum += x[++hi], count++;
    while (lo < i - half) sum -= x[lo++], count--;
    const value = x[i] - sum / count;
    out[i] = value > 0 ? value : 0;
  }
  return out;
}
