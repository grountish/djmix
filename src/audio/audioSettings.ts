/** Settings of the audio output, kept in localStorage. */
export type LatencyHint = 'interactive' | 'balanced' | 'playback';

export interface AudioSettings {
  /** `'default'` follows the system; otherwise a MediaDeviceInfo deviceId. */
  outputDeviceId: string;
  /** Null: the device's own rate. Takes effect when the app restarts. */
  sampleRate: number | null;
  /** How big an output buffer the browser picks. Takes effect when the app restarts. */
  latencyHint: LatencyHint;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  outputDeviceId: 'default',
  sampleRate: null,
  latencyHint: 'interactive',
};

export const SAMPLE_RATES = [44100, 48000, 88200, 96000];

export const LATENCY_HINTS: { hint: LatencyHint; label: string }[] = [
  { hint: 'interactive', label: 'Low (interactive)' },
  { hint: 'balanced', label: 'Balanced' },
  { hint: 'playback', label: 'Safe (playback)' },
];

const STORAGE_KEY = 'djmix.audioSettings';

export function loadAudioSettings(): AudioSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AUDIO_SETTINGS };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

export function saveAudioSettings(settings: AudioSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings)));
  } catch {
    // No storage (a test, a private window): the settings last for the session.
  }
}

function sanitize(value: unknown): AudioSettings {
  const v = (value ?? {}) as Partial<AudioSettings>;
  return {
    outputDeviceId: typeof v.outputDeviceId === 'string' && v.outputDeviceId ? v.outputDeviceId : 'default',
    sampleRate: typeof v.sampleRate === 'number' && SAMPLE_RATES.includes(v.sampleRate) ? v.sampleRate : null,
    latencyHint: LATENCY_HINTS.some((l) => l.hint === v.latencyHint) ? (v.latencyHint as LatencyHint) : 'interactive',
  };
}
