import { useState, useRef, useCallback } from 'react';
import type { DeckState, PlaybackMode } from '@/types';
import { Waveform, EmptyWaveform } from './Waveform';

interface DeckProps {
  id: 'A' | 'B';
  state: DeckState;
  otherDeckHasBpm: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onTargetBpmChange: (bpm: number | null) => void;
  onSync: () => void;
  onModeChange: (mode: PlaybackMode) => void;
  onPitchChange: (rate: number) => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const PITCH_BEND_AMOUNT = 0.04; // 4% pitch bend

export function Deck({
  id,
  state,
  otherDeckHasBpm,
  onPlayPause,
  onSeek,
  onTargetBpmChange,
  onSync,
  onModeChange,
  onPitchChange,
}: DeckProps) {
  const { track, playback, targetBpm, playbackMode } = state;
  const [targetBpmInput, setTargetBpmInput] = useState(targetBpm?.toString() || '');
  const basePitchRef = useRef(playback.playbackRate);
  const isBendingRef = useRef(false);

  // Store base pitch when not bending
  if (!isBendingRef.current) {
    basePitchRef.current = playback.playbackRate;
  }

  const handlePitchBendStart = useCallback(
    (direction: 'up' | 'down') => {
      isBendingRef.current = true;
      const bendAmount = direction === 'up' ? PITCH_BEND_AMOUNT : -PITCH_BEND_AMOUNT;
      onPitchChange(basePitchRef.current + bendAmount);
    },
    [onPitchChange],
  );

  const handlePitchBendEnd = useCallback(() => {
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

  const effectiveBpm = track?.analysis?.manualBpm || track?.analysis?.bpm;

  // Calculate current playing BPM based on playback mode and rate
  const currentBpm = effectiveBpm
    ? playbackMode === 'stretch'
      ? effectiveBpm // Stretch mode preserves tempo
      : effectiveBpm * playback.playbackRate // Rate mode changes tempo with pitch
    : null;

  const handleTargetBpmSubmit = () => {
    const bpm = parseFloat(targetBpmInput);
    if (!isNaN(bpm) && bpm > 0) {
      onTargetBpmChange(bpm);
    }
  };

  return (
    <div className="deck">
      <div className="deck-header">
        <div className="deck-artwork">
          {track?.artwork ? (
            <img src={track.artwork} alt="Album artwork" className="artwork-image" />
          ) : (
            <div className="artwork-placeholder">
              <span>🎵</span>
            </div>
          )}
        </div>
        <div className="deck-info">
          <span className="deck-label">Deck {id}</span>
          {track ? (
            <>
              <span className="deck-track-name">{track.title || track.fileName}</span>
              {track.artist && <span className="deck-artist">{track.artist}</span>}
            </>
          ) : (
            <span className="deck-no-track">No track loaded</span>
          )}
        </div>
        <div className="deck-bpm-display">
          <span className="bpm-value">{effectiveBpm ? effectiveBpm.toFixed(1) : '--'}</span>
          <span className="bpm-label">BPM</span>
          {currentBpm && currentBpm !== effectiveBpm && (
            <span className="bpm-current">{currentBpm.toFixed(1)}</span>
          )}
        </div>
      </div>

      <div className="waveform-pitch-row">
        <div className="waveform-section">
          {track?.waveformData ? (
            <Waveform
              data={track.waveformData}
              spectralData={track.spectralWaveform}
              currentTime={playback.currentTime}
              duration={playback.duration}
              bpm={track.analysis?.manualBpm || track.analysis?.bpm}
              firstBeatTime={track.analysis?.firstBeatTime}
              phrases={track.analysis?.phrases}
              onSeek={onSeek}
            />
          ) : (
            <EmptyWaveform />
          )}

          <div className="deck-time">
            <span>{formatTime(playback.currentTime)}</span>
            <span>{formatTime(playback.duration)}</span>
          </div>
        </div>

        <div className="pitch-fader-vertical">
          <div className="pitch-bend-buttons-vertical">
            <button
              className="pitch-bend-button"
              onMouseDown={() => handlePitchBendStart('up')}
              onMouseUp={handlePitchBendEnd}
              onMouseLeave={handlePitchBendEnd}
              onTouchStart={() => handlePitchBendStart('up')}
              onTouchEnd={handlePitchBendEnd}
              disabled={!track}>
              +
            </button>
          </div>
          <div className="pitch-slider-vertical-container">
            <input
              type="range"
              className="pitch-slider-vertical"
              min="0.5"
              max="1.5"
              step="0.01"
              value={basePitchRef.current}
              onChange={(e) => handlePitchSliderChange(Number(e.target.value))}
            />
          </div>
          <span className="pitch-value-vertical">
            {((basePitchRef.current - 1) * 100).toFixed(1)}%
          </span>
          <button
            className="pitch-reset-button"
            onClick={() => handlePitchSliderChange(1)}
            disabled={!track}>
            0
          </button>
          <div className="pitch-bend-buttons-vertical">
            <button
              className="pitch-bend-button"
              onMouseDown={() => handlePitchBendStart('down')}
              onMouseUp={handlePitchBendEnd}
              onMouseLeave={handlePitchBendEnd}
              onTouchStart={() => handlePitchBendStart('down')}
              onTouchEnd={handlePitchBendEnd}
              disabled={!track}>
              -
            </button>
          </div>
        </div>
      </div>

      <div className="deck-controls">
        <button className="play-button" onClick={onPlayPause} disabled={!track}>
          {playback.isPlaying ? '⏸' : '▶'}
        </button>

        <div className="deck-sync">
          <input
            type="number"
            className="target-bpm-input"
            placeholder="Target BPM"
            value={targetBpmInput}
            onChange={(e) => setTargetBpmInput(e.target.value)}
            onBlur={handleTargetBpmSubmit}
            onKeyDown={(e) => e.key === 'Enter' && handleTargetBpmSubmit()}
          />
          <button
            className="sync-button"
            onClick={onSync}
            disabled={!track || !effectiveBpm || (!targetBpm && !otherDeckHasBpm)}>
            Sync
          </button>
        </div>

        <div className="deck-mode-toggle">
          <button
            className={`mode-button ${playbackMode === 'rate' ? 'active' : ''}`}
            onClick={() => onModeChange('rate')}>
            Rate
          </button>
          <button
            className={`mode-button ${playbackMode === 'stretch' ? 'active' : ''}`}
            onClick={() => onModeChange('stretch')}>
            Stretch
          </button>
        </div>
      </div>
    </div>
  );
}
