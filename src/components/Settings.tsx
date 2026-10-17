import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AudioSettings,
  LATENCY_HINTS,
  type LatencyHint,
  loadAudioSettings,
  SAMPLE_RATES,
  saveAudioSettings,
} from '@/audio/audioSettings';
import { getAudioContext } from '@/audio/decoder';
import {
  applyOutputDevice,
  canSelectOutput,
  type ContextInfo,
  DEFAULT_OUTPUT,
  describeContext,
  listOutputDevices,
  type OutputDevice,
} from '@/audio/engine/outputDevice';
import '@/styles/settings.css';

interface SettingsProps {
  onClose: () => void;
}

/**
 * Audio settings: the output device switches live; the sample rate and buffer size are fixed
 * for the life of the AudioContext, so those take effect when the app restarts.
 */
export function Settings({ onClose }: SettingsProps) {
  const [settings, setSettings] = useState<AudioSettings>(() => loadAudioSettings());
  /** What the running context was opened with, to say when a restart is needed. */
  const applied = useRef<AudioSettings>(loadAudioSettings());
  const [devices, setDevices] = useState<OutputDevice[]>([DEFAULT_OUTPUT]);
  const [info, setInfo] = useState<ContextInfo | null>(null);
  const [canRoute, setCanRoute] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      listOutputDevices()
        .then((list) => {
          if (!cancelled) setDevices(list);
        })
        .catch(() => {});
    };
    refresh();
    const media = navigator.mediaDevices;
    media?.addEventListener?.('devicechange', refresh);
    try {
      const ctx = getAudioContext();
      setInfo(describeContext(ctx));
      setCanRoute(canSelectOutput(ctx));
    } catch {
      // No audio context yet (nothing played): the readout stays empty.
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      media?.removeEventListener?.('devicechange', refresh);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const update = useCallback(
    (patch: Partial<AudioSettings>): AudioSettings => {
      const next = { ...settings, ...patch };
      setSettings(next);
      saveAudioSettings(next);
      return next;
    },
    [settings],
  );

  const chooseDevice = async (deviceId: string) => {
    update({ outputDeviceId: deviceId });
    setError(null);
    try {
      const ctx = getAudioContext();
      await applyOutputDevice(ctx, deviceId);
      setInfo(describeContext(ctx));
    } catch (e) {
      setError(`Could not switch the output: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const restartNeeded =
    settings.sampleRate !== applied.current.sampleRate || settings.latencyHint !== applied.current.latencyHint;

  const knownDevice = devices.some((d) => d.deviceId === settings.outputDeviceId);

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings" role="dialog" aria-label="Audio settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title">Audio</span>
          <button className="settings-close" onClick={onClose} title="Close (Esc)">
            Close
          </button>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-output">
            Output
          </label>
          <select
            id="settings-output"
            value={knownDevice ? settings.outputDeviceId : 'default'}
            disabled={!canRoute}
            onChange={(e) => void chooseDevice(e.target.value)}>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        {!canRoute && <p className="settings-note">This browser can't route audio to a chosen output.</p>}
        {error && <p className="settings-error">{error}</p>}

        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-rate">
            Sample rate
          </label>
          <select
            id="settings-rate"
            value={settings.sampleRate ?? 'auto'}
            onChange={(e) => update({ sampleRate: e.target.value === 'auto' ? null : Number(e.target.value) })}>
            <option value="auto">Device default</option>
            {SAMPLE_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate / 1000} kHz
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-latency">
            Buffer
          </label>
          <select
            id="settings-latency"
            value={settings.latencyHint}
            onChange={(e) => update({ latencyHint: e.target.value as LatencyHint })}>
            {LATENCY_HINTS.map(({ hint, label }) => (
              <option key={hint} value={hint}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <p className={`settings-note ${restartNeeded ? 'restart' : ''}`}>
          {restartNeeded
            ? 'Sample rate and buffer changes take effect when the app restarts.'
            : 'Sample rate and buffer apply when the app starts. A smaller buffer cuts latency; pick Safe if the audio crackles.'}
        </p>

        {info && (
          <div className="settings-info">
            Running at {info.sampleRate} Hz · buffer {info.baseLatencyMs.toFixed(1)} ms
            {info.outputLatencyMs > 0 ? ` · ${info.outputLatencyMs.toFixed(0)} ms to the output` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
