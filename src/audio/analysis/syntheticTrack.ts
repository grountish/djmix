/**
 * Deterministic house-style test tracks with exact ground truth (beat, downbeat and section
 * times) for analysis tests.
 */
export interface SyntheticSection {
  bars: number;
  kick?: boolean;
  clap?: boolean;
  hats?: boolean;
  bass?: boolean;
  chords?: boolean;
}

export interface SyntheticTrackOptions {
  bpm: number;
  /** Tempo at the last beat; linear drift from `bpm` when set. */
  endBpm?: number;
  firstDownbeat: number;
  sections: SyntheticSection[];
  sampleRate?: number;
}

export interface SyntheticTrack {
  channels: Float32Array[];
  sampleRate: number;
  beatTimes: number[];
  /** Section start bars, plus the total bar count. */
  sectionBars: number[];
}

// Am – F – C – G, one chord per bar. MIDI notes of the triad and the bass root.
const PROGRESSION = [
  { chord: [57, 60, 64], bass: 33 },
  { chord: [53, 57, 60], bass: 29 },
  { chord: [48, 52, 55], bass: 36 },
  { chord: [55, 59, 62], bass: 31 },
];

const midiHz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

export function synthesizeTrack(options: SyntheticTrackOptions): SyntheticTrack {
  const sampleRate = options.sampleRate ?? 44100;
  const totalBars = options.sections.reduce((s, section) => s + section.bars, 0);
  const totalBeats = totalBars * 4;

  const startPeriod = 60 / options.bpm;
  const endPeriod = 60 / (options.endBpm ?? options.bpm);
  const beatTimes: number[] = [options.firstDownbeat];
  for (let k = 1; k <= totalBeats; k++) {
    const period = startPeriod + ((endPeriod - startPeriod) * (k - 1)) / Math.max(1, totalBeats - 1);
    beatTimes.push(beatTimes[k - 1] + period);
  }

  const length = Math.ceil((beatTimes[totalBeats] + 1) * sampleRate);
  const out = new Float32Array(length);
  const noise = createNoise(12345);

  const sectionBars: number[] = [];
  let bar = 0;
  for (const section of options.sections) {
    sectionBars.push(bar);
    for (let b = 0; b < section.bars; b++, bar++) {
      const harmony = PROGRESSION[bar % PROGRESSION.length];
      for (let beat = 0; beat < 4; beat++) {
        const k = bar * 4 + beat;
        const time = beatTimes[k];
        const period = beatTimes[k + 1] - time;
        if (section.kick) addKick(out, sampleRate, time);
        if (section.clap && beat % 2 === 1) addNoiseHit(out, sampleRate, time, 0.3, 0.05, 1, noise);
        if (section.hats) addNoiseHit(out, sampleRate, time + period / 2, 0.12, 0.02, 2, noise);
        if (section.bass) {
          addTone(out, sampleRate, [midiHz(harmony.bass)], time + 0.25 * period, 0.65 * period, 0.35);
        }
      }
      if (section.chords) {
        const barStart = beatTimes[bar * 4];
        const barLength = beatTimes[bar * 4 + 4] - barStart;
        addTone(out, sampleRate, harmony.chord.map(midiHz), barStart, barLength, 0.08);
      }
    }
  }
  sectionBars.push(bar);

  return { channels: [out, out.slice()], sampleRate, beatTimes, sectionBars };
}

function addKick(out: Float32Array, sampleRate: number, time: number): void {
  const start = Math.round(time * sampleRate);
  const length = Math.round(0.35 * sampleRate);
  let phase = 0;
  for (let i = 0; i < length && start + i < out.length; i++) {
    const t = i / sampleRate;
    phase += (2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03))) / sampleRate;
    const attack = Math.min(1, t / 0.001);
    out[start + i] += 0.8 * attack * Math.exp(-t / 0.15) * Math.sin(phase);
  }
}

/** Noise burst; each `highpassOrder` differentiation pushes it further up the spectrum. */
function addNoiseHit(
  out: Float32Array,
  sampleRate: number,
  time: number,
  amplitude: number,
  decay: number,
  highpassOrder: number,
  noise: () => number,
): void {
  const start = Math.round(time * sampleRate);
  const length = Math.round(decay * 5 * sampleRate);
  const previous = new Array(highpassOrder + 1).fill(0);
  for (let i = 0; i < length && start + i < out.length; i++) {
    let value = noise();
    for (let order = 0; order < highpassOrder; order++) {
      const next = value - previous[order];
      previous[order] = value;
      value = next / 2;
    }
    out[start + i] += amplitude * Math.exp(-i / sampleRate / decay) * value;
  }
}

function addTone(
  out: Float32Array,
  sampleRate: number,
  frequencies: number[],
  time: number,
  duration: number,
  amplitude: number,
): void {
  const start = Math.round(time * sampleRate);
  const length = Math.round(duration * sampleRate);
  const fade = Math.round(0.005 * sampleRate);
  for (let i = 0; i < length && start + i < out.length; i++) {
    const envelope = Math.min(1, i / fade, (length - i) / fade);
    let value = 0;
    for (const hz of frequencies) value += Math.sin((2 * Math.PI * hz * i) / sampleRate);
    out[start + i] += amplitude * envelope * value;
  }
}

function createNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x80000000 - 1;
  };
}
