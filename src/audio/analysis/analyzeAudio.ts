import { anchoredClock, constantClock } from './beatClock';
import { fitBeatGrid } from './beatGrid';
import { detectKey, toCamelot } from './key';
import { findDownbeatPhase } from './downbeat';
import { downsampleForAnalysis, toMono } from './dsp';
import { measureLoudness } from './loudness';
import { computeSpectralFeatures } from './spectrum';
import { analyzeStructure } from './structure';
import { applyTempoHint, estimateTempo } from './tempo';
import { ANALYZER_VERSION, type AnalysisHints, type AudioAnalysis } from './types';

/**
 * Full track analysis from raw channel data. Pure and synchronous: runs in a worker or Node.
 * `hints` carries what the file's tags say (a tagged tempo settles the octave).
 */
export function analyzeAudio(channels: Float32Array[], sampleRate: number, hints: AnalysisHints = {}): AudioAnalysis {
  const mono = toMono(channels);
  const duration = mono.length / sampleRate;
  const reduced = downsampleForAnalysis(mono, sampleRate);
  const spectral = computeSpectralFeatures(reduced.samples, reduced.sampleRate);

  const bpmEstimate = applyTempoHint(estimateTempo(spectral.flux, spectral.sampleRate / spectral.hop), hints.bpm);
  const grid = fitBeatGrid(mono, sampleRate, spectral, bpmEstimate);
  const clock =
    grid.anchors && grid.anchors.length >= 2
      ? anchoredClock(grid.anchors, grid.period)
      : constantClock(grid.beatTime, grid.period);

  // First beat at or after 0 s whose index matches the downbeat phase.
  const downbeat = findDownbeatPhase(spectral, clock, duration);
  const firstBeat = Math.ceil(clock.beatAt(0) - 1e-9);
  const downbeatBeat = firstBeat + ((((downbeat.phase - firstBeat) % 4) + 4) % 4);
  const structure = analyzeStructure(spectral, clock, downbeatBeat, duration);
  const key = detectKey(mono, sampleRate);

  return {
    analyzerVersion: ANALYZER_VERSION,
    bpm: grid.bpm,
    bpmConfidence: Math.round(grid.coverage * 100) / 100,
    firstBeatTime: clock.timeOf(downbeatBeat),
    downbeatConfidence: Math.round(downbeat.confidence * 100) / 100,
    tempo: {
      isConstant: grid.isConstant,
      residualMs: Math.round(grid.residualMs * 100) / 100,
      anchors: grid.anchors?.map((a) => ({ beat: a.beat - downbeatBeat, time: a.time })),
    },
    bars: structure.bars,
    phrases: structure.phrases,
    loudness: measureLoudness(channels, sampleRate),
    key: {
      tonic: key.tonic,
      mode: key.mode,
      camelot: toCamelot(key),
      confidence: Math.round(key.confidence * 100) / 100,
      source: 'audio',
    },
  };
}
