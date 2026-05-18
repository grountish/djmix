let audioContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

export async function decodeAudioFile(filePath: string): Promise<AudioBuffer> {
  const buffer = await window.electronAPI.readFile(filePath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;

  const ctx = getAudioContext();
  return ctx.decodeAudioData(arrayBuffer);
}

export async function decodeAudioFromFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = getAudioContext();
  return ctx.decodeAudioData(arrayBuffer);
}

export async function getAudioDuration(filePath: string): Promise<number> {
  const audioBuffer = await decodeAudioFile(filePath);
  return audioBuffer.duration;
}

export interface SpectralWaveformData {
  low: number[];
  mid: number[];
  high: number[];
  combined: number[];
}

export function generateWaveformData(audioBuffer: AudioBuffer, samples: number = 4800): number[] {
  const channelData = audioBuffer.getChannelData(0);
  const blockSize = Math.floor(channelData.length / samples);
  const waveform: number[] = [];

  for (let i = 0; i < samples; i++) {
    const start = i * blockSize;
    const end = start + blockSize;

    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += Math.abs(channelData[j]);
    }

    waveform.push(sum / blockSize);
  }

  const max = Math.max(...waveform);
  return waveform.map((v) => v / max);
}

// Generate spectral waveform data with separate low/mid/high frequency bands
export function generateSpectralWaveform(
  audioBuffer: AudioBuffer,
  samples: number = 4800,
): SpectralWaveformData {
  const channelData = audioBuffer.getChannelData(0);
  const blockSize = Math.floor(channelData.length / samples);

  // Simple band-pass filtering using running averages
  const low: number[] = [];
  const mid: number[] = [];
  const high: number[] = [];
  const combined: number[] = [];

  // Create simple low-pass filtered version for bass detection
  const lowPassData = new Float32Array(channelData.length);
  const highPassData = new Float32Array(channelData.length);

  // Very simple IIR filters
  const lowAlpha = 0.05; // Low frequencies
  const highAlpha = 0.9; // High frequencies

  let lowAcc = 0;
  let highAcc = 0;

  for (let i = 0; i < channelData.length; i++) {
    lowAcc = lowAlpha * channelData[i] + (1 - lowAlpha) * lowAcc;
    lowPassData[i] = lowAcc;

    highAcc = highAlpha * channelData[i] + (1 - highAlpha) * highAcc;
    highPassData[i] = channelData[i] - highAcc;
  }

  for (let i = 0; i < samples; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, channelData.length);

    let lowSum = 0;
    let highSum = 0;
    let totalSum = 0;

    for (let j = start; j < end; j++) {
      lowSum += Math.abs(lowPassData[j]);
      highSum += Math.abs(highPassData[j]);
      totalSum += Math.abs(channelData[j]);
    }

    const count = end - start;
    low.push(lowSum / count);
    high.push(highSum / count);
    combined.push(totalSum / count);
    // Mid is whatever's left
    mid.push(Math.max(0, (totalSum - lowSum - highSum) / count));
  }

  // Normalize each band
  const normalize = (arr: number[]) => {
    const max = Math.max(...arr, 0.001);
    return arr.map((v) => v / max);
  };

  return {
    low: normalize(low),
    mid: normalize(mid),
    high: normalize(high),
    combined: normalize(combined),
  };
}
