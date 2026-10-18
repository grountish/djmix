import { useCallback, useRef, useState, type DragEvent } from 'react';
import type { AnalysisOverrides, DeckState, PlaybackMode, SyncMode } from '@/types';
import { effectiveAnalysis, hasCorrections, resolveOverrides } from '@/audio/analysis/overrides';
import { trackClock } from '@/audio/mix/trackClock';
import { KeyBadge } from './KeyBadge';
import { OverrideControls } from './OverrideControls';
import { Waveform, EmptyWaveform, type MixMarks } from './Waveform';

/** Drag type library rows carry; decks accept it. */
export const TRACK_DRAG_TYPE = 'application/x-djmix-track';

interface DeckProps {
  id: 'A' | 'B';
  state: DeckState;
  otherDeckHasBpm: boolean;
  onPlayPause: () => void;
  onCue: () => void;
  onSeek: (time: number) => void;
  onTargetBpmChange: (bpm: number | null) => void;
  onSync: () => void;
  onModeChange: (mode: PlaybackMode) => void;
  onPitchChange: (rate: number) => void;
  onOverridesChange: (trackId: string, overrides: AnalysisOverrides | undefined) => void;
  onDropTrack: (trackId: string) => void;
  /** The next mix, drawn on the waveform. */
  mixMarks?: MixMarks | null;
  /** What SYNC lines up, for its tooltip. */
  syncMode: SyncMode;
  /** Loops `beats` beats from the nearest beat to the playhead. */
  onLoop: (beats: number) => void;
  onLoopIn: () => void;
  onLoopOut: () => void;
  onLoopHalve: () => void;
  onLoopDouble: () => void;
  /** Exits a running loop, re-enters a kept one, or loops 4 bars without one. */
  onLoopToggle: () => void;
}

/** Quick auto-loop lengths, in bars. */
const LOOP_BARS = [1, 2, 4, 8, 16];

/** A loop length in beats as bars: "4", "1/2". */
function formatLoopBars(beats: number): string {
  const bars = beats / 4;
  if (bars >= 1 && Math.abs(bars - Math.round(bars)) < 0.01) return String(Math.round(bars));
  const denominator = Math.round(1 / bars);
  if (denominator > 0 && Math.abs(bars * denominator - 1) < 0.01) return `1/${denominator}`;
  return `${beats.toFixed(1)}b`;
}

const SYNC_TITLES: Record<SyncMode, string> = {
  tempo: "Match the other deck's tempo (or the target BPM)",
  beat: "Match the other deck's tempo and land on its beat; a stopped deck starts on its next beat",
  bar: "Match the other deck's tempo and its bar line; a stopped deck starts on its next bar",
  phrase: "Match the other deck's tempo and phrase position; a stopped deck starts on its next bar",
};

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Tempo fader range either side of the track's own tempo. */
const PITCH_RANGE = 0.16;
const PITCH_BEND_AMOUNT = 0.04;

export function Deck({
  id,
  state,
  otherDeckHasBpm,
  onPlayPause,
  onCue,
  onSeek,
  onTargetBpmChange,
  onSync,
  onModeChange,
  onPitchChange,
  onOverridesChange,
  onDropTrack,
  mixMarks,
  syncMode,
  onLoop,
  onLoopIn,
  onLoopOut,
  onLoopHalve,
  onLoopDouble,
  onLoopToggle,
}: DeckProps) {
  const { track, playback, targetBpm, playbackMode, cuePoint, loop, loading } = state;
  const [targetBpmInput, setTargetBpmInput] = useState(targetBpm?.toString() || '');
  const [showGrid, setShowGrid] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const basePitchRef = useRef(playback.playbackRate);
  const isBendingRef = useRef(false);
  if (!isBendingRef.current) basePitchRef.current = playback.playbackRate;

  const handlePitchBendStart = useCallback(
    (direction: 'up' | 'down') => {
      isBendingRef.current = true;
      onPitchChange(basePitchRef.current + (direction === 'up' ? PITCH_BEND_AMOUNT : -PITCH_BEND_AMOUNT));
    },
    [onPitchChange],
  );
  const handlePitchBendEnd = useCallback(() => {
    if (!isBendingRef.current) return;
    isBendingRef.current = false;
    onPitchChange(basePitchRef.current);
  }, [onPitchChange]);
  const handlePitchSliderChange = useCallback(
    (value: number) => {
      basePitchRef.current = value;
      onPitchChange(value);
    },
    [onPitchChange],
  );

  const analysis = track ? effectiveAnalysis(track) : null;
  const corrected = !!track?.analysis && hasCorrections(resolveOverrides(track.analysis, track.overrides));
  const baseBpm = analysis?.bpm;
  const currentBpm = baseBpm ? baseBpm * playback.playbackRate : null;
  const pitchPercent = (basePitchRef.current - 1) * 100;
  const clock = analysis ? trackClock(analysis) : undefined;
  const loopBeats = loop
    ? clock
      ? clock.beatAt(loop.end) - clock.beatAt(loop.start)
      : (loop.end - loop.start) / (baseBpm ? 60 / baseBpm : 0.5)
    : null;

  const handleTargetBpmSubmit = () => {
    const bpm = parseFloat(targetBpmInput);
    onTargetBpmChange(!isNaN(bpm) && bpm > 0 ? bpm : null);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TRACK_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const trackId = e.dataTransfer.getData(TRACK_DRAG_TYPE);
    setDragOver(false);
    if (!trackId) return;
    e.preventDefault();
    onDropTrack(trackId);
  };

  return (
    <div
      className={`deck deck-${id.toLowerCase()} ${playback.isPlaying ? 'playing' : ''} ${dragOver ? 'drop-target' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}>
      <div className="deck-head">
        <span className="deck-badge">{id}</span>
        {track?.artwork ? (
          <img src={track.artwork} alt="" className="deck-art" />
        ) : (
          <div className="deck-art deck-art-empty" />
        )}
        <div className="deck-titles">
          {track ? (
            <>
              <div className="deck-title" title={track.fileName}>
                {track.title || track.fileName}
              </div>
              <div className="deck-artist">{track.artist || track.album || ' '}</div>
            </>
          ) : loading ? (
            <>
              <div className="deck-title deck-title-empty" title={loading.fileName}>
                {loading.title || loading.fileName}
              </div>
              <div className="deck-artist">Loading…</div>
            </>
          ) : (
            <>
              <div className="deck-title deck-title-empty">No track loaded</div>
              <div className="deck-artist">{' '}</div>
            </>
          )}
        </div>
        <div className="deck-readouts">
          <div className="readout readout-bpm" title={baseBpm ? `Track tempo ${baseBpm.toFixed(2)} BPM` : undefined}>
            <span className="readout-value">{currentBpm ? currentBpm.toFixed(2) : '—'}</span>
            <span className="readout-label">
              {corrected && <span className="override-dot" title="Analysis corrected by hand" />}
              BPM
            </span>
          </div>
          <div className="readout readout-pitch">
            <span className={`readout-value ${Math.abs(pitchPercent) > 0.05 ? 'moved' : ''}`}>
              {pitchPercent > 0 ? '+' : ''}
              {pitchPercent.toFixed(1)}%
            </span>
            <span className="readout-label">Tempo</span>
          </div>
          <div className="readout readout-key">
            <span className="readout-value">{analysis?.key ? <KeyBadge trackKey={analysis.key} /> : '—'}</span>
            <span className="readout-label">Key</span>
          </div>
        </div>
      </div>

      <div className="deck-body">
        <div className="deck-waves">
          {track?.waveformData ? (
            <Waveform
              data={track.waveformData}
              spectralData={track.spectralWaveform}
              currentTime={playback.currentTime}
              duration={playback.duration}
              bpm={baseBpm}
              clock={clock}
              phrases={analysis?.phrases}
              cuePoint={cuePoint}
              marks={mixMarks}
              loop={loop}
              onSeek={onSeek}
            />
          ) : (
            <EmptyWaveform hint={!loading} />
          )}
          {loading && (
            <div className="deck-loading" role="status" aria-live="polite">
              <span className="spinner" />
              <span className="deck-loading-text">Loading {loading.title || loading.fileName}</span>
            </div>
          )}
          <div className="deck-time">
            <span className="time-elapsed">{formatTime(playback.currentTime)}</span>
            <span className="time-bar">
              {clock && baseBpm ? `bar ${Math.floor(clock.beatAt(playback.currentTime) / 4) + 1}` : ''}
            </span>
            <span className="time-remaining">-{formatTime(Math.max(0, playback.duration - playback.currentTime))}</span>
          </div>
        </div>

        <div className="pitch">
          <button
            className="pitch-bend"
            title="Nudge slower while held"
            onMouseDown={() => handlePitchBendStart('down')}
            onMouseUp={handlePitchBendEnd}
            onMouseLeave={handlePitchBendEnd}
            onTouchStart={() => handlePitchBendStart('down')}
            onTouchEnd={handlePitchBendEnd}
            disabled={!track}>
            −
          </button>
          <input
            type="range"
            className="pitch-slider"
            min={1 - PITCH_RANGE}
            max={1 + PITCH_RANGE}
            step="0.001"
            value={basePitchRef.current}
            title="Tempo fader (double-click to reset)"
            onChange={(e) => handlePitchSliderChange(Number(e.target.value))}
            onDoubleClick={() => handlePitchSliderChange(1)}
            disabled={!track}
          />
          <button
            className="pitch-bend"
            title="Nudge faster while held"
            onMouseDown={() => handlePitchBendStart('up')}
            onMouseUp={handlePitchBendEnd}
            onMouseLeave={handlePitchBendEnd}
            onTouchStart={() => handlePitchBendStart('up')}
            onTouchEnd={handlePitchBendEnd}
            disabled={!track}>
            +
          </button>
        </div>
      </div>

      <div className="deck-transport">
        <button
          className={`tbtn tbtn-cue ${cuePoint !== null ? 'set' : ''}`}
          onClick={onCue}
          disabled={!track}
          title="Playing: back to the cue point and stop. Stopped: set the cue point here.">
          CUE
        </button>
        <button className={`tbtn tbtn-play ${playback.isPlaying ? 'active' : ''}`} onClick={onPlayPause} disabled={!track}>
          {playback.isPlaying ? '❚❚' : '▶'}
        </button>
        <span className="tbtn-gap" />
        <button
          className="tbtn tbtn-sync"
          onClick={onSync}
          disabled={!track || !baseBpm || (!targetBpm && !otherDeckHasBpm)}
          title={SYNC_TITLES[syncMode]}>
          SYNC
        </button>
        <button
          className={`tbtn tbtn-key ${playbackMode === 'stretch' ? 'active' : ''}`}
          onClick={() => onModeChange(playbackMode === 'stretch' ? 'rate' : 'stretch')}
          disabled={!track}
          title="Key lock: keep the pitch when the tempo changes">
          KEY
        </button>
        <input
          type="number"
          className="deck-target"
          placeholder="target"
          title="Target BPM for SYNC when the other deck is empty"
          value={targetBpmInput}
          onChange={(e) => setTargetBpmInput(e.target.value)}
          onBlur={handleTargetBpmSubmit}
          onKeyDown={(e) => e.key === 'Enter' && handleTargetBpmSubmit()}
        />
        <span className="tbtn-gap" />
        <button
          className={`tbtn tbtn-grid ${showGrid ? 'active' : ''} ${corrected ? 'set' : ''}`}
          onClick={() => setShowGrid((v) => !v)}
          disabled={!track?.analysis}
          title="Beat grid and key corrections">
          GRID
        </button>
      </div>

      <div className="deck-loop">
        <button className="tbtn tbtn-small" onClick={onLoopIn} disabled={!track} title="Loop in: mark the loop start on the nearest beat">
          IN
        </button>
        <button
          className="tbtn tbtn-small"
          onClick={onLoopOut}
          disabled={!track}
          title="Loop out: close the loop on the nearest beat and start looping">
          OUT
        </button>
        <button
          className={`tbtn tbtn-loop ${loop?.active ? 'active' : ''} ${loop && !loop.active ? 'set' : ''}`}
          onClick={onLoopToggle}
          disabled={!track}
          title={loop?.active ? 'Exit the loop (it is kept)' : loop ? 'Loop again' : 'Loop 4 bars from the nearest beat'}>
          {loop && loopBeats !== null ? `LOOP ${formatLoopBars(loopBeats)}` : 'LOOP'}
        </button>
        <button className="tbtn tbtn-small" onClick={onLoopHalve} disabled={!loop} title="Halve the loop">
          ½
        </button>
        <button className="tbtn tbtn-small" onClick={onLoopDouble} disabled={!loop} title="Double the loop">
          ×2
        </button>
        <span className="tbtn-gap" />
        {LOOP_BARS.map((bars) => (
          <button
            key={bars}
            className={`tbtn tbtn-size ${loop?.active && loopBeats !== null && Math.abs(loopBeats - bars * 4) < 0.01 ? 'active' : ''}`}
            onClick={() => onLoop(bars * 4)}
            disabled={!track}
            title={`Loop ${bars} bar${bars === 1 ? '' : 's'} from the nearest beat`}>
            {bars}
          </button>
        ))}
      </div>

      {showGrid && track?.analysis && (
        <OverrideControls
          analysis={track.analysis}
          overrides={track.overrides}
          onChange={(overrides) => onOverridesChange(track.id, overrides)}
        />
      )}
    </div>
  );
}
