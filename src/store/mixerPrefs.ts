import { type CrossfaderSettings, CROSSFADER_CURVES, DEFAULT_CROSSFADER } from '@/audio/engine/crossfaderCurve';
import { SYNC_MODES, type SyncMode } from '@/audio/engine/sync';

/** Mixer preferences that outlive a session: the crossfader law and what SYNC lines up. */
export interface MixerPrefs {
  crossfader: CrossfaderSettings;
  syncMode: SyncMode;
}

export const DEFAULT_MIXER_PREFS: MixerPrefs = { crossfader: { ...DEFAULT_CROSSFADER }, syncMode: 'beat' };

const STORAGE_KEY = 'djmix.mixerPrefs';

export function loadMixerPrefs(): MixerPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MIXER_PREFS };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_MIXER_PREFS };
  }
}

export function saveMixerPrefs(prefs: MixerPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(sanitize(prefs)));
  } catch {
    // No storage: the preferences last for the session.
  }
}

function sanitize(value: unknown): MixerPrefs {
  const v = (value ?? {}) as Partial<MixerPrefs>;
  const curve = CROSSFADER_CURVES.some((c) => c.curve === v.crossfader?.curve)
    ? v.crossfader!.curve
    : DEFAULT_CROSSFADER.curve;
  return {
    crossfader: { curve, reverse: v.crossfader?.reverse === true },
    syncMode: SYNC_MODES.some((m) => m.mode === v.syncMode) ? (v.syncMode as SyncMode) : DEFAULT_MIXER_PREFS.syncMode,
  };
}
