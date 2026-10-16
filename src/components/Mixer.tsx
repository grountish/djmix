import type { EqBand } from '@/types';

type DeckId = 'A' | 'B';

interface ChannelControls {
  eq: Record<EqBand, number>;
  filter: number;
}

const EQ_ROWS: { band: EqBand | 'filter'; label: string; title: string }[] = [
  { band: 'high', label: 'Hi', title: 'High band (above 2.5 kHz)' },
  { band: 'mid', label: 'Mid', title: 'Mid band (200 Hz – 2.5 kHz)' },
  { band: 'low', label: 'Low', title: 'Low band (below 200 Hz)' },
  { band: 'filter', label: 'Flt', title: 'Filter: left low-pass, right high-pass' },
];

function EqControl({
  value,
  title,
  isFilter,
  onChange,
}: {
  value: number;
  title: string;
  isFilter: boolean;
  onChange: (value: number) => void;
}) {
  const state = value <= -1 && !isFilter ? 'killed' : value !== 0 ? 'moved' : '';
  return (
    <input
      type="range"
      className={`eq-slider ${state}`}
      min="-100"
      max="100"
      value={Math.round(value * 100)}
      title={`${title} (double-click to reset)`}
      onChange={(e) => onChange(Number(e.target.value) / 100)}
      onDoubleClick={() => onChange(0)}
    />
  );
}

interface MixerProps {
  channelA: ChannelControls;
  channelB: ChannelControls;
  onEqChange: (deck: DeckId, band: EqBand, value: number) => void;
  onFilterChange: (deck: DeckId, value: number) => void;
  crossfader: number;
  masterVolume: number;
  volumeA: number;
  volumeB: number;
  automixEnabled: boolean;
  canTriggerAutomix: boolean;
  onCrossfaderChange: (value: number) => void;
  onMasterVolumeChange: (volume: number) => void;
  onVolumeAChange: (volume: number) => void;
  onVolumeBChange: (volume: number) => void;
  onAutomixToggle: () => void;
  onTriggerAutomix: () => void;
}

export function Mixer({
  channelA,
  channelB,
  onEqChange,
  onFilterChange,
  crossfader,
  masterVolume,
  volumeA,
  volumeB,
  automixEnabled,
  canTriggerAutomix,
  onCrossfaderChange,
  onMasterVolumeChange,
  onVolumeAChange,
  onVolumeBChange,
  onAutomixToggle,
  onTriggerAutomix,
}: MixerProps) {
  return (
    <div className="mixer-section">
      <div className="mixer-header">Mixer</div>

      <div className="eq-section">
        {EQ_ROWS.map(({ band, label, title }) => {
          const control = (deck: DeckId, channel: ChannelControls) =>
            band === 'filter' ? (
              <EqControl
                value={channel.filter}
                title={title}
                isFilter
                onChange={(value) => onFilterChange(deck, value)}
              />
            ) : (
              <EqControl
                value={channel.eq[band]}
                title={title}
                isFilter={false}
                onChange={(value) => onEqChange(deck, band, value)}
              />
            );
          return (
            <div className="eq-row" key={band}>
              {control('A', channelA)}
              <span className="eq-label">{label}</span>
              {control('B', channelB)}
            </div>
          );
        })}
      </div>

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
          title="Plan and run a phrase-aligned transition into the other deck">
          Mix
        </button>
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
