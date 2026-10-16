/** Second-order IIR section, normalised so a0 = 1. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Q values of the two sections of a 4th-order Butterworth filter. */
export const BUTTERWORTH4_Q = [0.5411961, 1.3065630];

// Coefficients from the RBJ Audio EQ Cookbook.
export function lowpass(fc: number, sampleRate: number, q: number = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function highpass(fc: number, sampleRate: number, q: number = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function highShelf(fc: number, sampleRate: number, gainDb: number, q: number): Biquad {
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const sqrtA2alpha = 2 * Math.sqrt(a) * alpha;
  const a0 = a + 1 - (a - 1) * cos + sqrtA2alpha;
  return {
    b0: (a * (a + 1 + (a - 1) * cos + sqrtA2alpha)) / a0,
    b1: (-2 * a * (a - 1 + (a + 1) * cos)) / a0,
    b2: (a * (a + 1 + (a - 1) * cos - sqrtA2alpha)) / a0,
    a1: (2 * (a - 1 - (a + 1) * cos)) / a0,
    a2: (a + 1 - (a - 1) * cos - sqrtA2alpha) / a0,
  };
}

/** Filters `x` in place (transposed direct form II). */
export function applyBiquad(x: Float32Array, c: Biquad): void {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = c.b0 * xi + z1;
    z1 = c.b1 * xi - c.a1 * y + z2;
    z2 = c.b2 * xi - c.a2 * y;
    x[i] = y;
  }
}

/** Zero-phase filtering: forward then backward through every section. Returns a new array. */
export function filtfilt(x: Float32Array, sections: Biquad[]): Float32Array {
  const y = x.slice();
  for (const section of sections) applyBiquad(y, section);
  y.reverse();
  for (const section of sections) applyBiquad(y, section);
  y.reverse();
  return y;
}

export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0].slice();
  const mono = new Float32Array(channels[0].length);
  const scale = 1 / channels.length;
  for (const channel of channels) {
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] * scale;
  }
  return mono;
}

/** Integer-factor decimation to roughly 22 kHz with a zero-phase anti-alias filter. */
export function downsampleForAnalysis(
  x: Float32Array,
  sampleRate: number,
): { samples: Float32Array; sampleRate: number } {
  const factor = Math.max(1, Math.round(sampleRate / 22050));
  if (factor === 1) return { samples: x, sampleRate };

  const cutoff = (0.45 * sampleRate) / factor;
  const filtered = filtfilt(
    x,
    BUTTERWORTH4_Q.map((q) => lowpass(cutoff, sampleRate, q)),
  );
  const out = new Float32Array(Math.floor(filtered.length / factor));
  for (let i = 0; i < out.length; i++) out[i] = filtered[i * factor];
  return { samples: out, sampleRate: sampleRate / factor };
}

/**
 * Real-input FFT of size n (power of two), computed as an n/2-point complex FFT plus a
 * split step.
 */
export class RealFFT {
  readonly size: number;
  private readonly half: number;
  private readonly bitReverse: Uint32Array;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(size: number) {
    if (size < 4 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two`);
    this.size = size;
    this.half = size / 2;
    const m = this.half;

    this.bitReverse = new Uint32Array(m);
    const bits = Math.log2(m);
    for (let i = 0; i < m; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.bitReverse[i] = r;
    }

    // Twiddles for the full size n; the n/2 complex FFT uses every other entry.
    this.cosTable = new Float64Array(m);
    this.sinTable = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.re = new Float64Array(m);
    this.im = new Float64Array(m);
  }

  /** Spectrum bins 0..n/2 of a real frame of length n. */
  forward(input: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    const m = this.half;
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < m; i++) {
      const j = this.bitReverse[i];
      re[j] = input[2 * i];
      im[j] = input[2 * i + 1];
    }

    for (let size = 2; size <= m; size *= 2) {
      const halfSize = size / 2;
      const step = (2 * m) / size; // index stride into the size-n twiddle table
      for (let start = 0; start < m; start += size) {
        for (let k = 0; k < halfSize; k++) {
          const wr = this.cosTable[k * step];
          const wi = -this.sinTable[k * step];
          const a = start + k;
          const b = a + halfSize;
          const tr = wr * re[b] - wi * im[b];
          const ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }

    // Split the packed even/odd transform into the real-input spectrum.
    for (let k = 0; k <= m; k++) {
      const k1 = k % m;
      const k2 = (m - k) % m;
      const er = (re[k1] + re[k2]) / 2;
      const ei = (im[k1] - im[k2]) / 2;
      const or = (im[k1] + im[k2]) / 2;
      const oi = -(re[k1] - re[k2]) / 2;
      const c = k === m ? -1 : this.cosTable[k];
      const s = k === m ? 0 : this.sinTable[k];
      outRe[k] = er + c * or + s * oi;
      outIm[k] = ei + c * oi - s * or;
    }
  }
}

export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  return w;
}

/** Sub-sample peak position from three neighbouring values (parabolic fit). */
export function parabolicOffset(left: number, centre: number, right: number): number {
  const denom = left - 2 * centre + right;
  if (denom === 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom));
}

export function median(values: ArrayLike<number>): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

export function powerToDb(power: number): number {
  return 10 * Math.log10(power + 1e-12);
}
