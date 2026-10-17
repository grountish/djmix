import type { AppState } from '@/store/AppContext';
import { getMeter, getMixGraph, type MeterTarget } from '@/audio/engine/liveGraph';
import { getAudioContext } from '@/audio/decoder';
import type { MixGraph } from '@/audio/engine/mixGraph';
import { setPlanPolicy } from '@/audio/automixController';
import type { PlanPolicy } from '@/audio/mix/planner';

/**
 * What the live tests (e2e/) drive: the store and the audio graph, on `window.__djmix`.
 * Installed in development builds only.
 */
export interface DjmixTestBridge {
  getState: () => AppState;
  /** The provider's actions; replaced on every render, so always read it fresh. */
  actions: unknown;
  getMixGraph: () => MixGraph;
  getMeter: (target: MeterTarget) => AnalyserNode;
  getAudioContext: () => AudioContext;
  /** Plan policy overrides for the transitions made from now on; {} resets. */
  setPlanPolicy: (policy: Partial<PlanPolicy>) => void;
}

declare global {
  interface Window {
    __djmix?: DjmixTestBridge;
  }
}

export function installTestBridge(getState: () => AppState, actions: unknown): void {
  if (!import.meta.env.DEV) return;
  window.__djmix = { getState, actions, getMixGraph, getMeter, getAudioContext, setPlanPolicy };
}
