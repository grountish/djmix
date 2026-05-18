import type { BpmAnalyzer, BpmAnalyzerResult } from '@/types';

const BPM_MIN = 60;
const BPM_MAX = 200;
const NORMALIZED_BPM_MIN = 85;
const NORMALIZED_BPM_MAX = 175;

export function normalizeBpm(bpm: number): number {
  let normalized = bpm;

  while (normalized < NORMALIZED_BPM_MIN && normalized * 2 <= BPM_MAX) {
    normalized *= 2;
  }
  while (normalized > NORMALIZED_BPM_MAX && normalized / 2 >= BPM_MIN) {
    normalized /= 2;
  }

  return Math.round(normalized * 10) / 10;
}

export class WebAudioBpmAnalyzer implements BpmAnalyzer {
  async analyze(audioBuffer: AudioBuffer): Promise<BpmAnalyzerResult> {
    try {
      const { guess } = await import('web-audio-beat-detector');

      // Find the section with rhythmic content (skip ambient intros)
      const activeStartTime = this.findActiveSection(audioBuffer);

      // Extract buffer starting from active section, up to 30 seconds
      const sampleBuffer = this.extractBuffer(audioBuffer, activeStartTime, 30);

      const result = await guess(sampleBuffer);
      const rawBpm = typeof result === 'number' ? result : result.bpm;
      const normalizedBpm = normalizeBpm(rawBpm);

      const confidence = this.estimateConfidence(rawBpm, normalizedBpm);
      // Detect first beat in full buffer
      const firstBeatTime = this.detectFirstBeat(audioBuffer, normalizedBpm);

      return {
        bpm: normalizedBpm,
        confidence,
        firstBeatTime,
      };
    } catch (error) {
      console.error('BPM analysis failed:', error);
      return this.fallbackAnalysis(audioBuffer);
    }
  }

  /**
   * Find the start time of the active/rhythmic section of the audio.
   * Skips silent or ambient intros by looking for consistent transient activity.
   */
  private findActiveSection(audioBuffer: AudioBuffer): number {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const frameSize = Math.floor(sampleRate * 0.05); // 50ms frames
    const hopSize = frameSize;

    // Calculate transient density in each frame
    const frameDensities: number[] = [];

    for (let i = 0; i < channelData.length - frameSize; i += hopSize) {
      let transients = 0;
      let prevSample = 0;

      for (let j = 0; j < frameSize; j++) {
        const sample = Math.abs(channelData[i + j]);
        // Count quick rises in amplitude (transients)
        if (sample > prevSample * 1.5 && sample > 0.05) {
          transients++;
        }
        prevSample = Math.max(sample, 0.001);
      }

      frameDensities.push(transients);
    }

    // Find where sustained transient activity begins
    const windowSize = 10; // Look at 10 frames (~500ms) at a time
    const minActivityThreshold = 3; // Need at least 3 transients per window

    for (let i = 0; i < frameDensities.length - windowSize; i++) {
      let windowActivity = 0;
      for (let j = 0; j < windowSize; j++) {
        windowActivity += frameDensities[i + j];
      }

      if (windowActivity >= minActivityThreshold * windowSize * 0.5) {
        // Found active section
        return (i * hopSize) / sampleRate;
      }
    }

    return 0; // Default to start if no active section found
  }

  /**
   * Extract a portion of the audio buffer starting at a given time.
   */
  private extractBuffer(
    audioBuffer: AudioBuffer,
    startTime: number,
    maxSeconds: number,
  ): AudioBuffer {
    const sampleRate = audioBuffer.sampleRate;
    const startSample = Math.floor(startTime * sampleRate);
    const maxSamples = Math.floor(maxSeconds * sampleRate);
    const availableSamples = audioBuffer.length - startSample;
    const numSamples = Math.min(maxSamples, availableSamples);

    if (numSamples <= 0 || startSample >= audioBuffer.length) {
      // Fallback: just return trimmed from start
      return this.trimBuffer(audioBuffer, maxSeconds);
    }

    const offlineCtx = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      numSamples,
      sampleRate,
    );

    const extractedBuffer = offlineCtx.createBuffer(
      audioBuffer.numberOfChannels,
      numSamples,
      sampleRate,
    );

    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
      const sourceData = audioBuffer.getChannelData(channel);
      const destData = extractedBuffer.getChannelData(channel);
      destData.set(sourceData.subarray(startSample, startSample + numSamples));
    }

    return extractedBuffer;
  }

  private trimBuffer(audioBuffer: AudioBuffer, maxSeconds: number): AudioBuffer {
    const maxSamples = Math.min(
      audioBuffer.length,
      Math.floor(audioBuffer.sampleRate * maxSeconds),
    );

    if (maxSamples >= audioBuffer.length) {
      return audioBuffer;
    }

    const offlineCtx = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      maxSamples,
      audioBuffer.sampleRate,
    );

    const trimmedBuffer = offlineCtx.createBuffer(
      audioBuffer.numberOfChannels,
      maxSamples,
      audioBuffer.sampleRate,
    );

    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
      const sourceData = audioBuffer.getChannelData(channel);
      const destData = trimmedBuffer.getChannelData(channel);
      destData.set(sourceData.subarray(0, maxSamples));
    }

    return trimmedBuffer;
  }

  private estimateConfidence(rawBpm: number, normalizedBpm: number): number {
    const wasNormalized = rawBpm !== normalizedBpm;
    const inTypicalRange = normalizedBpm >= 100 && normalizedBpm <= 140;

    let confidence = 0.7;
    if (wasNormalized) confidence -= 0.2;
    if (inTypicalRange) confidence += 0.1;

    return Math.max(0.1, Math.min(1, confidence));
  }

  private fallbackAnalysis(audioBuffer: AudioBuffer): BpmAnalyzerResult {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;

    const peaks = this.detectPeaks(channelData, sampleRate);
    const bpm = this.calculateBpmFromPeaks(peaks, sampleRate);
    const normalizedBpm = normalizeBpm(bpm || 120);
    const firstBeatTime = this.detectFirstBeat(audioBuffer, normalizedBpm);

    return {
      bpm: normalizedBpm,
      confidence: 0.3,
      firstBeatTime,
    };
  }

  private detectPeaks(data: Float32Array, sampleRate: number): number[] {
    const peaks: number[] = [];
    const windowSize = Math.floor(sampleRate * 0.1); // 100ms windows
    const threshold = 0.7;

    let maxInWindow = 0;
    let maxIndex = 0;

    for (let i = 0; i < data.length; i++) {
      const absValue = Math.abs(data[i]);

      if (absValue > maxInWindow) {
        maxInWindow = absValue;
        maxIndex = i;
      }

      if (i % windowSize === windowSize - 1) {
        if (maxInWindow > threshold) {
          peaks.push(maxIndex);
        }
        maxInWindow = 0;
      }
    }

    return peaks;
  }

  private calculateBpmFromPeaks(peaks: number[], sampleRate: number): number {
    if (peaks.length < 2) return 120;

    const intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push(peaks[i] - peaks[i - 1]);
    }

    intervals.sort((a, b) => a - b);
    const medianInterval = intervals[Math.floor(intervals.length / 2)];

    const secondsPerBeat = medianInterval / sampleRate;
    const bpm = 60 / secondsPerBeat;

    return bpm;
  }

  /**
   * Detect the first beat in the audio by finding transients that form a consistent beat pattern.
   * This handles tracks with long intros or ambient beginnings by looking for actual rhythmic content.
   */
  private detectFirstBeat(audioBuffer: AudioBuffer, bpm: number): number {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const beatDuration = 60 / bpm;

    // Step 1: Detect onsets using spectral flux (transient detection)
    const onsets = this.detectOnsets(channelData, sampleRate);

    if (onsets.length === 0) {
      return 0;
    }

    // Step 2: Find onset clusters that match the BPM pattern
    // Look for sequences of onsets that are spaced at beat intervals
    const tolerance = beatDuration * 0.15; // 15% tolerance for beat matching
    const minConsecutiveBeats = 4; // Need at least 4 consecutive beats to confirm pattern

    let bestFirstBeat = onsets[0];
    let bestScore = 0;

    // Try each onset as a potential first beat
    for (let i = 0; i < Math.min(onsets.length, 100); i++) {
      const candidateFirstBeat = onsets[i];
      let consecutiveMatches = 1;
      let totalScore = 0;

      // Check how many subsequent beats match the expected pattern
      for (let beatNum = 1; beatNum <= 16; beatNum++) {
        const expectedBeatTime = candidateFirstBeat + beatNum * beatDuration;

        // Find if there's an onset near this expected beat time
        let foundMatch = false;
        for (const onset of onsets) {
          if (Math.abs(onset - expectedBeatTime) < tolerance) {
            foundMatch = true;
            // Score based on how close the onset is to expected position
            const accuracy = 1 - Math.abs(onset - expectedBeatTime) / tolerance;
            totalScore += accuracy;
            break;
          }
        }

        if (foundMatch) {
          consecutiveMatches++;
        } else if (consecutiveMatches < minConsecutiveBeats) {
          // If we haven't found enough consecutive beats yet, this isn't a good candidate
          break;
        }
      }

      // Update best if this candidate has more consecutive matches or higher score
      if (consecutiveMatches >= minConsecutiveBeats && totalScore > bestScore) {
        bestScore = totalScore;
        bestFirstBeat = candidateFirstBeat;
      }
    }

    // If we didn't find a good pattern, use the first strong onset
    if (bestScore === 0) {
      // Find the first onset that has at least one follow-up beat
      for (let i = 0; i < onsets.length - 1; i++) {
        const gap = onsets[i + 1] - onsets[i];
        // Check if gap is approximately one beat, half beat, or two beats
        if (
          Math.abs(gap - beatDuration) < tolerance ||
          Math.abs(gap - beatDuration * 2) < tolerance * 2 ||
          Math.abs(gap - beatDuration * 4) < tolerance * 4
        ) {
          bestFirstBeat = onsets[i];
          break;
        }
      }
    }

    return Math.max(0, bestFirstBeat);
  }

  /**
   * Detect onsets (transients) in the audio using spectral flux.
   * Returns array of onset times in seconds.
   */
  private detectOnsets(channelData: Float32Array, sampleRate: number): number[] {
    const frameSize = Math.floor(sampleRate * 0.023); // ~23ms frames (1024 samples at 44.1kHz)
    const hopSize = Math.floor(frameSize / 4); // 75% overlap for better resolution
    const onsets: number[] = [];

    // Analyze only first 60 seconds to find the pattern
    const maxSamples = Math.min(channelData.length, sampleRate * 60);

    // Calculate spectral flux for each frame
    const fluxValues: number[] = [];
    let prevMagnitudes: number[] | null = null;

    for (let i = 0; i < maxSamples - frameSize; i += hopSize) {
      // Apply Hann window and calculate simple spectral content
      const magnitudes = this.calculateFrameMagnitudes(channelData, i, frameSize);

      if (prevMagnitudes !== null) {
        // Calculate spectral flux (sum of positive differences)
        let flux = 0;
        for (let j = 0; j < magnitudes.length; j++) {
          const diff = magnitudes[j] - prevMagnitudes[j];
          if (diff > 0) {
            flux += diff;
          }
        }
        fluxValues.push(flux);
      } else {
        fluxValues.push(0);
      }

      prevMagnitudes = magnitudes;
    }

    // Normalize flux values
    const maxFlux = Math.max(...fluxValues);
    if (maxFlux === 0) return [];

    // Find local peaks in spectral flux that exceed threshold
    const threshold = 0.3; // 30% of max flux
    const minOnsetGap = sampleRate * 0.05; // Minimum 50ms between onsets

    let lastOnsetSample = -minOnsetGap;

    for (let i = 2; i < fluxValues.length - 2; i++) {
      const normalizedFlux = fluxValues[i] / maxFlux;
      const samplePos = i * hopSize;

      // Check if this is a local peak
      const isPeak =
        fluxValues[i] > fluxValues[i - 1] &&
        fluxValues[i] > fluxValues[i - 2] &&
        fluxValues[i] >= fluxValues[i + 1] &&
        fluxValues[i] >= fluxValues[i + 2];

      // Check if it exceeds threshold and is far enough from last onset
      if (isPeak && normalizedFlux > threshold && samplePos - lastOnsetSample >= minOnsetGap) {
        const onsetTime = samplePos / sampleRate;
        onsets.push(onsetTime);
        lastOnsetSample = samplePos;
      }
    }

    return onsets;
  }

  /**
   * Calculate magnitude spectrum for a frame (simplified FFT-like analysis)
   */
  private calculateFrameMagnitudes(data: Float32Array, start: number, frameSize: number): number[] {
    // Split into frequency bands using simple filtering
    const numBands = 8;
    const bandSize = Math.floor(frameSize / numBands);
    const magnitudes: number[] = [];

    for (let band = 0; band < numBands; band++) {
      let energy = 0;
      const bandStart = start + band * bandSize;
      const bandEnd = Math.min(bandStart + bandSize, start + frameSize);

      for (let i = bandStart; i < bandEnd; i++) {
        if (i < data.length) {
          // Apply Hann window
          const windowPos = (i - start) / frameSize;
          const window = 0.5 * (1 - Math.cos(2 * Math.PI * windowPos));
          const sample = data[i] * window;
          energy += sample * sample;
        }
      }

      magnitudes.push(Math.sqrt(energy / bandSize));
    }

    return magnitudes;
  }
}

let analyzerInstance: BpmAnalyzer | null = null;

export function getBpmAnalyzer(): BpmAnalyzer {
  if (!analyzerInstance) {
    analyzerInstance = new WebAudioBpmAnalyzer();
  }
  return analyzerInstance;
}

export function setBpmAnalyzer(analyzer: BpmAnalyzer): void {
  analyzerInstance = analyzer;
}
