import { analyzeAudio } from './analyzeAudio';
import type { AnalysisRequest, AnalysisResponse } from './analysisClient';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalysisRequest>) => void) | null;
  postMessage(message: AnalysisResponse): void;
};

scope.onmessage = (event) => {
  const { id, channels, sampleRate, hints } = event.data;
  try {
    scope.postMessage({ id, analysis: analyzeAudio(channels, sampleRate, hints) });
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
