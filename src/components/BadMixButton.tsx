import { useState } from 'react';
import { effectiveAnalysis } from '@/audio/analysis/overrides';
import { recentTransitions } from '@/audio/automixController';
import { getMasterRecorder, RECORDER_SECONDS } from '@/audio/engine/liveGraph';
import { encodeWav } from '@/audio/engine/wav';
import { useApp } from '@/store/AppContext';
import type { DeckState, DiagnosticReport, Track } from '@/types';

/**
 * "Flag mix": saves the last RECORDER_SECONDS of the master output as a WAV together with a
 * JSON report (both decks' tracks, their corrected analyses, the recent transition plans
 * and the mixer state), so that a mix that sounded wrong can be diagnosed afterwards with
 * the same tools as an offline render. In Electron the report lands in a folder under the
 * app's data directory; in a browser it is downloaded.
 */
export function BadMixButton() {
  const { state } = useApp();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const flag = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('saving…');
    try {
      const recorder = await getMasterRecorder();
      const dump = await recorder.dump();
      const wav = encodeWav(dump.channels, dump.sampleRate);
      const name = [state.deckA.track, state.deckB.track]
        .map((track) => track?.title || track?.fileName || 'empty')
        .join(' - ');
      const report: DiagnosticReport = {
        name,
        files: [
          { name: 'master.wav', bytes: wav },
          {
            name: 'report.json',
            text: JSON.stringify(
              {
                savedAt: new Date().toISOString(),
                audio: {
                  sampleRate: dump.sampleRate,
                  seconds: dump.channels[0]?.length / dump.sampleRate,
                  endsAtContextTime: dump.endTime,
                  recorderSeconds: RECORDER_SECONDS,
                },
                decks: { A: describeDeck(state.deckA), B: describeDeck(state.deckB) },
                mixer: { crossfader: state.crossfader, masterVolume: state.masterVolume },
                automix: state.automix,
                transitions: recentTransitions(),
              },
              null,
              2,
            ),
          },
        ],
      };
      const where = await save(report);
      setStatus(where ? `saved to ${where}` : 'saved (downloaded)');
    } catch (error) {
      console.error('Flag mix failed:', error);
      setStatus(`failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(null), 12000);
    }
  };

  return (
    <button
      type="button"
      onClick={flag}
      disabled={busy}
      title={`Save the last ${RECORDER_SECONDS} s of the master and the current plans for diagnosis`}
      style={{ marginLeft: 8, padding: '0 8px', font: 'inherit', cursor: busy ? 'wait' : 'pointer' }}
    >
      {status ?? 'Flag mix'}
    </button>
  );
}

/** Everything about a deck that matters for diagnosis, without the waveform and artwork payloads. */
function describeDeck(deck: DeckState) {
  const track = deck.track;
  return {
    track: track ? describeTrack(track) : null,
    playback: deck.playback,
    cuePoint: deck.cuePoint,
    playbackMode: deck.playbackMode,
    eq: deck.eq,
    filter: deck.filter,
  };
}

function describeTrack(track: Track) {
  const analysis = effectiveAnalysis(track);
  return {
    id: track.id,
    fileName: track.fileName,
    filePath: track.filePath,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    tagBpm: track.tagBpm,
    tagKey: track.tagKey,
    overrides: track.overrides,
    analysisStatus: track.analysisStatus,
    analysis: analysis
      ? {
          analyzerVersion: analysis.analyzerVersion,
          bpm: analysis.bpm,
          bpmConfidence: analysis.bpmConfidence,
          firstBeatTime: analysis.firstBeatTime,
          downbeatConfidence: analysis.downbeatConfidence,
          tempo: analysis.tempo,
          key: analysis.key,
          loudness: analysis.loudness,
          phrases: analysis.phrases,
          bars: analysis.bars,
        }
      : null,
  };
}

/** Electron: a folder under userData (its path). Browser: a download per file (null). */
async function save(report: DiagnosticReport): Promise<string | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (api?.reportSave) return api.reportSave(report);
  for (const file of report.files) {
    const blob = file.bytes ? new Blob([file.bytes.buffer as ArrayBuffer], { type: 'audio/wav' }) : new Blob([file.text ?? ''], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${report.name.replace(/[^\w.-]+/g, '_')}-${file.name}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return null;
}
