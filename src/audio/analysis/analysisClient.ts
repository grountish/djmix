import { analyzeAudio } from './analyzeAudio';
import type { AudioAnalysis } from './types';

export interface AnalysisRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
}

export type AnalysisResponse =
  | { id: number; analysis: AudioAnalysis; error?: undefined }
  | { id: number; error: string; analysis?: undefined };

interface PendingRequest {
  request: AnalysisRequest;
  resolve: (analysis: AudioAnalysis) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    console.warn('Analysis worker unavailable, analysing on the main thread:', error);
    workerFailed = true;
    return null;
  }

  worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.analysis) entry.resolve(event.data.analysis);
    else entry.reject(new Error(event.data.error));
  };

  // A worker that fails to load never answers: finish its requests on the main thread.
  worker.onerror = (event) => {
    console.warn('Analysis worker failed, analysing on the main thread:', event.message);
    worker?.terminate();
    worker = null;
    workerFailed = true;
    for (const [id, entry] of pending) {
      pending.delete(id);
      runOnMainThread(entry);
    }
  };
  return worker;
}

function runOnMainThread({ request, resolve, reject }: PendingRequest): void {
  try {
    resolve(analyzeAudio(request.channels, request.sampleRate));
  } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Analyses a decoded track off the main thread. */
export function analyzeAudioBuffer(buffer: AudioBuffer): Promise<AudioAnalysis> {
  // Posting clones the channel data; nothing is transferred, so a main-thread fallback can
  // still read the same arrays.
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const request: AnalysisRequest = { id: nextId++, channels, sampleRate: buffer.sampleRate };

  return new Promise((resolve, reject) => {
    const entry = { request, resolve, reject };
    const target = getWorker();
    if (!target) {
      runOnMainThread(entry);
      return;
    }
    pending.set(request.id, entry);
    target.postMessage(request);
  });
}
