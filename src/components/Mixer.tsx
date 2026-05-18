interface MixerProps {
  crossfader: number;
  masterVolume: number;
  volumeA: number;
  volumeB: number;
  automixEnabled: boolean;
  canTriggerAutomix: boolean;
  crossfadeDuration: number;
  onCrossfaderChange: (value: number) => void;
  onMasterVolumeChange: (volume: number) => void;
  onVolumeAChange: (volume: number) => void;
  onVolumeBChange: (volume: number) => void;
  onAutomixToggle: () => void;
  onTriggerAutomix: () => void;
  onCrossfadeDurationChange: (duration: number) => void;
}

export function Mixer({
  crossfader,
  masterVolume,
  volumeA,
  volumeB,
  automixEnabled,
  canTriggerAutomix,
  crossfadeDuration,
  onCrossfaderChange,
  onMasterVolumeChange,
  onVolumeAChange,
  onVolumeBChange,
  onAutomixToggle,
  onTriggerAutomix,
  onCrossfadeDurationChange,
}: MixerProps) {
  return (
    <div className="mixer-section">
      <div className="mixer-header">Mixer</div>

      <div className="channel-faders">
        <div className="channel-fader">
          <span className="channel-label">A</span>
          <input
            type="range"
            className="channel-fader-slider"
            min="0"
            max="100"
            value={volumeA * 100}
            onChange={(e) => onVolumeAChange(Number(e.target.value) / 100)}
          />
          <span className="channel-value">{Math.round(volumeA * 100)}</span>
        </div>
        <div className="channel-fader">
          <span className="channel-label">B</span>
          <input
            type="range"
            className="channel-fader-slider"
            min="0"
            max="100"
            value={volumeB * 100}
            onChange={(e) => onVolumeBChange(Number(e.target.value) / 100)}
          />
          <span className="channel-value">{Math.round(volumeB * 100)}</span>
        </div>
      </div>

      <div className="crossfader-container">
        <span className="crossfader-label">A</span>
        <input
          type="range"
          className="crossfader-slider"
          min="-100"
          max="100"
          value={crossfader * 100}
          onChange={(e) => onCrossfaderChange(Number(e.target.value) / 100)}
        />
        <span className="crossfader-label">B</span>
      </div>

      <div className="automix-controls">
        <button
          className={`automix-button ${automixEnabled ? 'active' : ''}`}
          onClick={onAutomixToggle}
          title="Enable/disable automix mode">
          Auto
        </button>
        <button
          className="automix-trigger-button"
          onClick={onTriggerAutomix}
          disabled={!canTriggerAutomix}
          title="Start transition on the next beat">
          Mix
        </button>
        <div className="crossfade-duration">
          <input
            type="range"
            className="duration-slider"
            min="2"
            max="32"
            step="1"
            value={crossfadeDuration}
            onChange={(e) => onCrossfadeDurationChange(Number(e.target.value))}
            title="Crossfade duration in seconds"
          />
          <span className="duration-label">{crossfadeDuration}s</span>
        </div>
      </div>

      <div className="master-volume">
        <span className="bpm-label">Master</span>
        <input
          type="range"
          className="master-volume-slider"
          min="0"
          max="100"
          value={masterVolume * 100}
          onChange={(e) => onMasterVolumeChange(Number(e.target.value) / 100)}
        />
        <span className="bpm-label">{Math.round(masterVolume * 100)}%</span>
      </div>
    </div>
  );
}
