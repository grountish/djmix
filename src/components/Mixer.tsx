import { useMemo } from 'react';
import type { CrossfaderSettings, EqBand, FxSettings, FxType } from '@/types';
import { CROSSFADER_CURVES } from '@/audio/engine/crossfaderCurve';
import { filterKnobToCutoffs } from '@/audio/engine/curves';
import { FX_BEATS, FX_TYPES } from '@/audio/engine/fx';
import { getMeter, type MeterTarget } from '@/audio/engine/liveGraph';
import { Knob } from './Knob';
import { Meter } from './Meter';

type DeckId = 'A' | 'B';

export interface ChannelControls {
  eq: Record<EqBand, number>;
  filter: number;
  volume: number;
  /** Gain knob, dB on top of the automatic trim. */
  trimDb: number;
  /** The automatic loudness trim in effect, dB (for the knob's tooltip). */
  autoTrimDb: number;
  fx: FxSettings;
}

/** Gain knob travel either side of 0 dB. */
const TRIM_RANGE_DB = 12;

const ROWS: { control: EqBand | 'filter' | 'gain'; label: string }[] = [
  { control: 'gain', label: 'GAIN' },
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

const signed = (db: number) => `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;

function gainTitle(trimDb: number, autoTrimDb: number): string {
  return `Gain ${signed(trimDb)} (auto trim ${signed(autoTrimDb)}, total ${signed(trimDb + autoTrimDb)})`;
}

/** A beat count as a division: 0.25 → "1/4". */
function formatBeats(beats: number): string {
  if (beats >= 1) return String(beats);
  const quarters = Math.round(beats * 4);
  return quarters === 2 ? '1/2' : `${quarters}/4`;
}

const FX_TITLES: Record<FxType, string> = {
  echo: 'Echo: repeats on the beat, post-fader (pull the fader down and the tail rings out)',
  flanger: 'Flanger: a sweep every N beats',
  phaser: 'Phaser: a sweep every N beats',
  reverb: 'Reverb',
};

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
  onTrimChange: (deck: DeckId, trimDb: number) => void;
  onFxChange: (deck: DeckId, fx: FxSettings) => void;
  crossfaderCurve: CrossfaderSettings;
  onCrossfaderCurveChange: (settings: CrossfaderSettings) => void;
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
  onTrimChange,
  onFxChange,
  crossfaderCurve,
  onCrossfaderCurveChange,
  automixEnabled,
  isTransitioning,
  canTriggerAutomix,
  onAutomixToggle,
  onTriggerAutomix,
}: MixerProps) {
  const meters = useMemo(() => ({ A: meterFor('A'), B: meterFor('B'), master: meterFor('master') }), []);
  const channels: Record<DeckId, ChannelControls> = { A: channelA, B: channelB };

  const knob = (deck: DeckId, control: EqBand | 'filter' | 'gain', label: string) => {
    const channel = channels[deck];
    if (control === 'gain') {
      return (
        <Knob
          value={channel.trimDb}
          min={-TRIM_RANGE_DB}
          max={TRIM_RANGE_DB}
          centre={0}
          label=""
          title={`${gainTitle(channel.trimDb, channel.autoTrimDb)} (double-click to reset)`}
          color={DECK_COLOR[deck]}
          onChange={(value) => onTrimChange(deck, value)}
        />
      );
    }
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

  const fxSelect = (deck: DeckId) => {
    const { fx } = channels[deck];
    return (
      <select
        className={`mixer-select ${fx.type ? 'on' : ''}`}
        value={fx.type ?? 'off'}
        title={fx.type ? FX_TITLES[fx.type] : 'Channel effect (post-fader)'}
        onChange={(e) => onFxChange(deck, { ...fx, type: e.target.value === 'off' ? null : (e.target.value as FxType) })}>
        <option value="off">OFF</option>
        {FX_TYPES.map(({ type, label }) => (
          <option key={type} value={type}>
            {label.toUpperCase()}
          </option>
        ))}
      </select>
    );
  };

  const beatsSelect = (deck: DeckId) => {
    const { fx } = channels[deck];
    const synced = !!fx.type && FX_TYPES.find((t) => t.type === fx.type)?.beatSynced;
    return (
      <select
        className="mixer-select"
        value={fx.beats}
        disabled={!synced}
        title={fx.type === 'echo' ? 'Echo time in beats' : 'Beats per sweep'}
        onChange={(e) => onFxChange(deck, { ...fx, beats: Number(e.target.value) })}>
        {FX_BEATS.map((beats) => (
          <option key={beats} value={beats}>
            {formatBeats(beats)}
          </option>
        ))}
      </select>
    );
  };

  const amountKnob = (deck: DeckId) => {
    const { fx } = channels[deck];
    return (
      <Knob
        value={fx.amount}
        min={0}
        max={1}
        centre={0}
        label=""
        title={`Effect amount ${Math.round(fx.amount * 100)}%`}
        color={DECK_COLOR[deck]}
        disabled={!fx.type}
        onChange={(value) => onFxChange(deck, { ...fx, amount: value })}
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

      <div className="mixer-fx">
        <div className="mixer-row">
          {fxSelect('A')}
          <span className="mixer-row-label">FX</span>
          {fxSelect('B')}
        </div>
        <div className="mixer-row">
          {beatsSelect('A')}
          <span className="mixer-row-label">BEAT</span>
          {beatsSelect('B')}
        </div>
        <div className="mixer-row">
          {amountKnob('A')}
          <span className="mixer-row-label">AMT</span>
          {amountKnob('B')}
        </div>
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
      <div className="xf-curve">
        {CROSSFADER_CURVES.map(({ curve, label }) => (
          <button
            key={curve}
            className={`xf-btn ${crossfaderCurve.curve === curve ? 'active' : ''}`}
            onClick={() => onCrossfaderCurveChange({ ...crossfaderCurve, curve })}
            title={
              curve === 'smooth'
                ? 'Smooth: both decks full in the centre, a gentle fade to either side (blends)'
                : curve === 'sharp'
                  ? 'Sharp: the far deck stays full until the last stretch of travel (cuts, scratching)'
                  : 'Linear: a straight fade from the centre'
            }>
            {label.toUpperCase()}
          </button>
        ))}
        <button
          className={`xf-btn ${crossfaderCurve.reverse ? 'active' : ''}`}
          onClick={() => onCrossfaderCurveChange({ ...crossfaderCurve, reverse: !crossfaderCurve.reverse })}
          title="Reverse (hamster): left is deck B, right is deck A">
          REV
        </button>
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
