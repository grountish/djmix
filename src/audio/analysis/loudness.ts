import { highpass, highShelf, type Biquad } from './dsp';

const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

/** True-peak interpolation: 4× oversampling with a windowed-sinc kernel of this radius. */
const OVERSAMPLE = 4;
const KERNEL_RADIUS = 6;
/** Only samples this close to the sample peak can produce the true peak. */
const TRUE_PEAK_CANDIDATE_RATIO = 0.7;

/** ITU-R BS.1770 integrated loudness (LUFS) and 4× oversampled true peak (dBTP). */
export function measureLoudness(
  channels: Float32Array[],
  sampleRate: number,
): { integratedLufs: number; truePeakDb: number } {
  const kWeighting = [highShelf(1500, sampleRate, 4, Math.SQRT1_2), highpass(38, sampleRate, 0.5)];
  const step = Math.round(STEP_SECONDS * sampleRate);
  const steps = Math.floor(channels[0].length / step);
  const stepPower = new Float64Array(steps);

  for (const channel of channels) {
    accumulateWeightedPower(channel, kWeighting, step, stepPower);
  }

  const stepsPerBlock = Math.round(BLOCK_SECONDS / STEP_SECONDS);
  const blockPower: number[] = [];
  for (let s = 0; s + stepsPerBlock <= steps; s++) {
    let sum = 0;
    for (let i = s; i < s + stepsPerBlock; i++) sum += stepPower[i];
    blockPower.push(sum / (stepsPerBlock * step));
  }

  const loudness = (power: number) => -0.691 + 10 * Math.log10(power);
  const meanPower = (powers: number[]) => powers.reduce((s, p) => s + p, 0) / powers.length;

  const aboveAbsolute = blockPower.filter((p) => loudness(p) > ABSOLUTE_GATE_LUFS);
  let integratedLufs = -Infinity;
  if (aboveAbsolute.length > 0) {
    const relativeGate = loudness(meanPower(aboveAbsolute)) + RELATIVE_GATE_LU;
    const gated = aboveAbsolute.filter((p) => loudness(p) > relativeGate);
    integratedLufs = loudness(meanPower(gated));
  }

  const truePeak = Math.max(...channels.map(channelTruePeak));
  return {
    integratedLufs: Math.round(integratedLufs * 100) / 100,
    truePeakDb: Math.round(20 * Math.log10(truePeak + 1e-12) * 100) / 100,
  };
}

function accumulateWeightedPower(
  channel: Float32Array,
  sections: Biquad[],
  step: number,
  stepPower: Float64Array,
): void {
  const state = sections.map(() => ({ z1: 0, z2: 0 }));
  for (let s = 0; s < stepPower.length; s++) {
    let sum = 0;
    for (let i = s * step; i < (s + 1) * step; i++) {
      let y = channel[i];
      for (let k = 0; k < sections.length; k++) {
        const c = sections[k];
        const z = state[k];
        const out = c.b0 * y + z.z1;
        z.z1 = c.b1 * y - c.a1 * out + z.z2;
        z.z2 = c.b2 * y - c.a2 * out;
        y = out;
      }
      sum += y * y;
    }
    stepPower[s] += sum;
  }
}

const kernels: Float64Array[] = Array.from({ length: OVERSAMPLE - 1 }, (_, p) => {
  const fraction = (p + 1) / OVERSAMPLE;
  const taps = new Float64Array(2 * KERNEL_RADIUS);
  let sum = 0;
  for (let j = 0; j < taps.length; j++) {
    const distance = fraction - (j - KERNEL_RADIUS + 1);
    const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
    const window = 0.5 * (1 + Math.cos((Math.PI * distance) / (KERNEL_RADIUS + 0.5)));
    taps[j] = sinc * window;
    sum += taps[j];
  }
  return taps.map((t) => t / sum);
});

function channelTruePeak(channel: Float32Array): number {
  let samplePeak = 0;
  for (let i = 0; i < channel.length; i++) samplePeak = Math.max(samplePeak, Math.abs(channel[i]));

  let peak = samplePeak;
  const threshold = samplePeak * TRUE_PEAK_CANDIDATE_RATIO;
  for (let i = KERNEL_RADIUS - 1; i + KERNEL_RADIUS < channel.length; i++) {
    if (Math.abs(channel[i]) < threshold && Math.abs(channel[i + 1]) < threshold) continue;
    for (const taps of kernels) {
      let value = 0;
      for (let j = 0; j < taps.length; j++) value += taps[j] * channel[i - KERNEL_RADIUS + 1 + j];
      peak = Math.max(peak, Math.abs(value));
    }
  }
  return peak;
}
