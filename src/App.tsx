import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/store/AppContext';
import { Browser, Deck, Mixer } from '@/components';
import { useAutoDj } from '@/store/useAutoDj';
import {
  importFiles,
  importFilesFromBrowser,
  createTrackFromFile,
  createTrackFromBrowserFile,
  createFileFingerprint,
  fingerprintToKey,
  analyzeAudioBuffer,
  decodeAudioFile,
  getCachedAnalysis,
  setCachedAnalysis,
  createAnalysisFromCache,
  isCurrentAnalysis,
  isElectronEnvironment,
  generateWaveformData,
  generateSpectralWaveform,
} from '@/audio';
import type { Track, TrackAnalysis } from '@/types';
import { keyFromTag } from '@/audio/analysis/key';
import { effectiveAnalysis } from '@/audio/analysis/overrides';
import '@/styles/index.css';

/** A key tag in the file beats the detected key. */
function withTaggedKey(analysis: TrackAnalysis, track: Track): TrackAnalysis {
  const tagged = keyFromTag(track.tagKey);
  return tagged ? { ...analysis, key: tagged } : analysis;
}

export function App() {
  const { state, actions } = useApp();
  useAutoDj();

  const analyzeTrack = useCallback(
    async (track: Track & { _audioBuffer?: AudioBuffer }): Promise<Track> => {
      if (isElectronEnvironment()) {
        const cached = await getCachedAnalysis(track);
        if (cached) {
          const fingerprint = createFileFingerprint(track);
          const cacheKey = fingerprintToKey(fingerprint);
          const analysis = withTaggedKey(createAnalysisFromCache(cached, cacheKey), track);
          return { ...track, analysis, analysisStatus: 'complete' };
        }
      }

      actions.updateTrack({ ...track, analysisStatus: 'analyzing' });

      try {
        const audioBuffer = track._audioBuffer || (await decodeAudioFile(track.filePath));
        const result = await analyzeAudioBuffer(audioBuffer);
        const fingerprint = createFileFingerprint(track);
        const cacheKey = fingerprintToKey(fingerprint);
        const analysis = withTaggedKey({ ...result, analyzedAt: new Date().toISOString(), cacheKey }, track);
        if (isElectronEnvironment()) await setCachedAnalysis(track, analysis);
        return { ...track, analysis, analysisStatus: 'complete' };
      } catch (error) {
        console.error('Analysis failed:', error);
        return { ...track, analysisStatus: 'error' };
      }
    },
    [actions],
  );

  const handleImport = useCallback(async () => {
    try {
      if (isElectronEnvironment()) {
        const filePaths = await importFiles();
        if (filePaths.length === 0) return;
        const existingPaths = new Set(state.tracks.map((t) => t.filePath));
        for (const filePath of filePaths.filter((p) => !existingPaths.has(p))) {
          try {
            actions.addTracks([await createTrackFromFile(filePath)]);
          } catch (error) {
            console.error(`Failed to import ${filePath}:`, error);
          }
        }
      } else {
        const files = await importFilesFromBrowser();
        if (files.length === 0) return;
        const existingNames = new Set(state.tracks.map((t) => t.fileName));
        for (const file of files.filter((f) => !existingNames.has(f.name))) {
          try {
            actions.addTracks([await createTrackFromBrowserFile(file)]);
          } catch (error) {
            console.error(`Failed to import ${file.name}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Import failed:', error);
    }
  }, [state.tracks, actions]);

  // Analyse pending tracks one at a time: each analysis holds a decoded track in memory.
  const analysisQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedTrackIdsRef = useRef(new Set<string>());

  useEffect(() => {
    for (const track of state.tracks) {
      if (track.analysisStatus !== 'pending' || queuedTrackIdsRef.current.has(track.id)) continue;
      queuedTrackIdsRef.current.add(track.id);
      analysisQueueRef.current = analysisQueueRef.current.then(async () => {
        actions.updateTrack(await analyzeTrack(track));
        queuedTrackIdsRef.current.delete(track.id);
      });
    }
  }, [state.tracks, analyzeTrack, actions]);

  // Load saved library on startup
  const libraryLoadedRef = useRef(false);
  const [isLibraryReady, setIsLibraryReady] = useState(false);
  const tracksCountAfterLoadRef = useRef(0);

  useEffect(() => {
    if (libraryLoadedRef.current) return;
    libraryLoadedRef.current = true;

    const loadLibrary = async () => {
      try {
        let savedTracks: Track[] = [];
        if (isElectronEnvironment()) {
          savedTracks = await window.electronAPI.libraryLoad();
        } else {
          const stored = localStorage.getItem('djmix-library');
          if (stored) savedTracks = JSON.parse(stored);
        }
        if (savedTracks.length === 0) {
          setIsLibraryReady(true);
          return;
        }

        if (isElectronEnvironment()) {
          const loadedTracks: Track[] = [];
          // Regenerate waveform data for each track
          for (const track of savedTracks) {
            try {
              const audioBuffer = await decodeAudioFile(track.filePath);
              const current = isCurrentAnalysis(track.analysis);
              loadedTracks.push({
                ...track,
                waveformData: generateWaveformData(audioBuffer),
                spectralWaveform: generateSpectralWaveform(audioBuffer),
                analysis: current ? track.analysis : null,
                analysisStatus: current ? 'complete' : 'pending',
              });
            } catch (error) {
              console.error(`Failed to load track ${track.fileName}:`, error);
            }
          }
          if (loadedTracks.length > 0) {
            tracksCountAfterLoadRef.current = loadedTracks.length;
            actions.addTracks(loadedTracks);
          }
        } else {
          // Browser mode: tracks already have waveform data stored (or need re-importing)
          const validTracks = savedTracks
            .filter((t) => t.waveformData)
            .map((t): Track => (isCurrentAnalysis(t.analysis) ? t : { ...t, analysis: null, analysisStatus: 'pending' }));
          if (validTracks.length > 0) {
            tracksCountAfterLoadRef.current = validTracks.length;
            actions.addTracks(validTracks);
          }
        }
      } catch (error) {
        console.error('Failed to load library:', error);
      } finally {
        setIsLibraryReady(true);
      }
    };

    loadLibrary();
  }, [actions]);

  // Save library when tracks change
  useEffect(() => {
    if (!isLibraryReady) return;
    // Don't overwrite the library with partial data right after loading.
    if (state.tracks.length === 0 && tracksCountAfterLoadRef.current > 0) return;

    const timeoutId = setTimeout(() => {
      if (isElectronEnvironment()) {
        window.electronAPI.librarySave(state.tracks);
      } else {
        try {
          localStorage.setItem('djmix-library', JSON.stringify(state.tracks));
        } catch (error) {
          console.error('Failed to save library to localStorage:', error);
        }
      }
      console.log('Library saved:', state.tracks.length, 'tracks');
    }, 1000);
    return () => clearTimeout(timeoutId);
  }, [state.tracks, isLibraryReady]);

  const loadTrackId = useCallback(
    (deck: 'A' | 'B', trackId: string) => {
      const track = state.tracks.find((t) => t.id === trackId);
      if (track) actions.loadToDeck(deck, track);
    },
    [state.tracks, actions],
  );
  const loadTrack = useCallback((deck: 'A' | 'B', track: Track) => actions.loadToDeck(deck, track), [actions]);
  const toggleQueue = useCallback(
    (id: string) => (state.queue.includes(id) ? actions.removeFromQueue(id) : actions.addToQueue(id)),
    [state.queue, actions],
  );

  const playingDeck = [state.deckA, state.deckB].find((d) => d.playback.isPlaying && d.track);
  const playingBpm = playingDeck?.track ? effectiveAnalysis(playingDeck.track)?.bpm : undefined;
  const masterBpm = playingBpm ? playingBpm * playingDeck!.playback.playbackRate : null;
  const analysing = state.tracks.filter((t) => t.analysisStatus === 'pending' || t.analysisStatus === 'analyzing').length;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">DJ MIX</span>
        <div className="master-clock" title="Tempo of the playing deck">
          <span className="clock-value">{masterBpm ? masterBpm.toFixed(2) : '—'}</span>
          <span className="clock-label">BPM</span>
        </div>
        <span className={`topbar-status ${state.automix.enabled ? 'auto-on' : ''}`} title={state.automix.status ?? ''}>
          {state.automix.status ?? (state.automix.enabled ? 'Auto: waiting for a playing deck' : '')}
        </span>
        <span className="topbar-meta">
          {analysing > 0 ? `Analysing ${analysing} of ${state.tracks.length}` : `${state.tracks.length} tracks`}
        </span>
      </header>

      <main className="decks">
        <Deck
          id="A"
          state={state.deckA}
          otherDeckHasBpm={!!state.deckB.track?.analysis?.bpm}
          onPlayPause={() => actions.playPauseDeck('A')}
          onCue={() => actions.pressCue('A')}
          onSeek={(time) => actions.seekDeck('A', time)}
          onTargetBpmChange={(bpm) => actions.setDeckTargetBpm('A', bpm)}
          onSync={() => actions.syncToTarget('A')}
          onModeChange={(mode) => actions.setDeckMode('A', mode)}
          onPitchChange={(rate) => actions.setDeckPitch('A', rate)}
          onOverridesChange={actions.setTrackOverrides}
          onDropTrack={(id) => loadTrackId('A', id)}
        />

        <Mixer
          channelA={{ eq: state.deckA.eq, filter: state.deckA.filter, volume: state.deckA.playback.volume }}
          channelB={{ eq: state.deckB.eq, filter: state.deckB.filter, volume: state.deckB.playback.volume }}
          onEqChange={actions.setDeckEq}
          onFilterChange={actions.setDeckFilter}
          onVolumeChange={actions.setDeckVolume}
          crossfader={state.crossfader}
          onCrossfaderChange={actions.setCrossfader}
          masterVolume={state.masterVolume}
          onMasterVolumeChange={actions.setMasterVolume}
          automixEnabled={state.automix.enabled}
          isTransitioning={state.automix.isTransitioning}
          canTriggerAutomix={!!state.deckA.track?.analysis && !!state.deckB.track?.analysis}
          onAutomixToggle={() => actions.setAutomixEnabled(!state.automix.enabled)}
          onTriggerAutomix={() => actions.triggerAutomix('now')}
        />

        <Deck
          id="B"
          state={state.deckB}
          otherDeckHasBpm={!!state.deckA.track?.analysis?.bpm}
          onPlayPause={() => actions.playPauseDeck('B')}
          onCue={() => actions.pressCue('B')}
          onSeek={(time) => actions.seekDeck('B', time)}
          onTargetBpmChange={(bpm) => actions.setDeckTargetBpm('B', bpm)}
          onSync={() => actions.syncToTarget('B')}
          onModeChange={(mode) => actions.setDeckMode('B', mode)}
          onPitchChange={(rate) => actions.setDeckPitch('B', rate)}
          onOverridesChange={actions.setTrackOverrides}
          onDropTrack={(id) => loadTrackId('B', id)}
        />
      </main>

      <Browser
        tracks={state.tracks}
        queue={state.queue}
        played={state.played}
        loaded={{ A: state.deckA.track?.id ?? null, B: state.deckB.track?.id ?? null }}
        playing={{ A: state.deckA.playback.isPlaying, B: state.deckB.playback.isPlaying }}
        sortOption={state.sortOption}
        filterOptions={state.filterOptions}
        referenceTrackId={state.referenceTrackId}
        direction={state.automix.direction}
        autoEnabled={state.automix.enabled}
        onImport={handleImport}
        onSortChange={actions.setSort}
        onFilterChange={actions.setFilter}
        onLoad={loadTrack}
        onToggleQueue={toggleQueue}
        onMoveInQueue={actions.moveInQueue}
        onSetReference={actions.setReferenceTrack}
        onDirectionChange={actions.setAutomixDirection}
        onSmartOrder={actions.smartOrderQueue}
      />

      <footer className="statusbar">
        <span className="status-left">
          <span className="status-deck status-deck-a">A</span> {state.deckA.track?.title || state.deckA.track?.fileName || 'empty'}
          <span className="status-sep" />
          <span className="status-deck status-deck-b">B</span> {state.deckB.track?.title || state.deckB.track?.fileName || 'empty'}
        </span>
        <span className="status-right">
          <span>Crossfader {Math.round(state.crossfader * 100)}</span>
          <span className="status-sep" />
          <span>Master {Math.round(state.masterVolume * 100)}%</span>
        </span>
      </footer>
    </div>
  );
}
