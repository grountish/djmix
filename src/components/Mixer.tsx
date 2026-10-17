import { useMemo } from 'react';
import type { EqBand } from '@/types';
import { filterKnobToCutoffs } from '@/audio/engine/curves';
import { getMeter, type MeterTarget } from '@/audio/engine/liveGraph';
import { Knob } from './Knob';
import { Meter } from './Meter';

type DeckId = 'A' | 'B';

export interface ChannelControls {
  eq: Record<EqBand, number>;
  filter: number;
  volume: number;
}

const ROWS: { control: EqBand | 'filter'; label: string }[] = [
  { control: 'high', label: 'HI' },
  { control: 'mid', label: 'MID' },
  { control: 'low', label: 'LOW' },
  { control: 'filter', label: 'FLT' },
];

const DECK_COLOR: Record<DeckId, string> = { A: 'var(--deck-a)', B: 'var(--deck-b)' };

function eqTitle(label: string, knob: number): string {
  if (knob <= -1) return `${label}: kill`;
  const db = knob >= 0 ? 6 * knob : 40 * Math.log10(1 + knob);
  return `${label}: ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function filterTitle(knob: number): string {
  if (Math.abs(knob) < 0.005) return 'Filter: off';
  const { lowpassHz, highpassHz } = filterKnobToCutoffs(knob, 22050);
  return knob < 0 ? `Low-pass ${Math.round(lowpassHz)} Hz` : `High-pass ${Math.round(highpassHz)} Hz`;
}

function meterFor(target: MeterTarget): AnalyserNode | null {
  try {
    return getMeter(target);
  } catch {
    return null;
  }
}

interface MixerProps {
  channelA: ChannelControls;
  channelB: ChannelControls;
  onEqChange: (deck: DeckId, band: EqBand, value: number) => void;
  onFilterChange: (deck: DeckId, value: number) => void;
  onVolumeChange: (deck: DeckId, volume: number) => void;
  crossfader: number;
  onCrossfaderChange: (value: number) => void;
  masterVolume: number;
  onMasterVolumeChange: (volume: number) => void;
  automixEnabled: boolean;
  isTransitioning: boolean;
  canTriggerAutomix: boolean;
  onAutomixToggle: () => void;
  onTriggerAutomix: () => void;
}

export function Mixer({
  channelA,
  channelB,
  onEqChange,
  onFilterChange,
  onVolumeChange,
  crossfader,
  onCrossfaderChange,
  masterVolume,
  onMasterVolumeChange,
  automixEnabled,
  isTransitioning,
  canTriggerAutomix,
  onAutomixToggle,
  onTriggerAutomix,
}: MixerProps) {
  const meters = useMemo(() => ({ A: meterFor('A'), B: meterFor('B'), master: meterFor('master') }), []);
  const channels: Record<DeckId, ChannelControls> = { A: channelA, B: channelB };

  const knob = (deck: DeckId, control: EqBand | 'filter', label: string) => {
    const channel = channels[deck];
    if (control === 'filter') {
      return (
        <Knob
          value={channel.filter}
          label=""
          title={`${filterTitle(channel.filter)} (double-click to reset)`}
          color={DECK_COLOR[deck]}
          onChange={(value) => onFilterChange(deck, value)}
        />
      );
    }
    return (
      <Knob
        value={channel.eq[control]}
        label=""
        title={`${eqTitle(label, channel.eq[control])} (double-click to reset)`}
        color={DECK_COLOR[deck]}
        killed={channel.eq[control] <= -1}
        onChange={(value) => onEqChange(deck, control, value)}
      />
    );
  };

  return (
    <div className="mixer">
      <div className="mixer-knobs">
        {ROWS.map(({ control, label }) => (
          <div className="mixer-row" key={control}>
            {knob('A', control, label)}
            <span className="mixer-row-label">{label}</span>
            {knob('B', control, label)}
          </div>
        ))}
      </div>

      <div className="mixer-faders">
        {(['A', 'B'] as const).map((deck) => (
          <div className={`channel channel-${deck.toLowerCase()}`} key={deck}>
            <div className="channel-strip">
              <input
                type="range"
                className="channel-fader"
                min="0"
                max="100"
                value={Math.round(channels[deck].volume * 100)}
                title={`Channel ${deck} fader: ${Math.round(channels[deck].volume * 100)}%`}
                onChange={(e) => onVolumeChange(deck, Number(e.target.value) / 100)}
              />
              <Meter analyser={meters[deck]} className="channel-meter" />
            </div>
            <span className="channel-name">{deck}</span>
          </div>
        ))}
        <div className="master-meter">
          <Meter analyser={meters.master} className="master-meter-canvas" />
          <span className="channel-name master-name">MST</span>
        </div>
      </div>

      <div className="crossfader">
        <span className="xf-label xf-a">A</span>
        <input
          type="range"
          className="crossfader-slider"
          min="-100"
          max="100"
          value={Math.round(crossfader * 100)}
          title="Crossfader (double-click to centre)"
          onChange={(e) => onCrossfaderChange(Number(e.target.value) / 100)}
          onDoubleClick={() => onCrossfaderChange(0)}
        />
        <span className="xf-label xf-b">B</span>
      </div>

      <div className="mixer-auto">
        <button
          className={`btn-auto ${automixEnabled ? 'active' : ''}`}
          onClick={onAutomixToggle}
          title="Auto DJ: plays the set hands-off, cueing and mixing in the next track">
          AUTO
        </button>
        <button
          className={`btn-mixnow ${isTransitioning ? 'busy' : ''}`}
          onClick={onTriggerAutomix}
          disabled={!canTriggerAutomix || isTransitioning}
          title="Mix into the other deck at the next 16/32-bar entry">
          {isTransitioning ? 'MIXING' : 'MIX NOW'}
        </button>
      </div>

      <div className="master">
        <span className="master-label">MASTER</span>
        <input
          type="range"
          className="master-slider"
          min="0"
          max="100"
          value={Math.round(masterVolume * 100)}
          onChange={(e) => onMasterVolumeChange(Number(e.target.value) / 100)}
        />
        <span className="master-value">{Math.round(masterVolume * 100)}</span>
      </div>
    </div>
  );
}
