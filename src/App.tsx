import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/store/AppContext';
import { Deck, Mixer, TrackLibrary } from '@/components';
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

/** A key tag in the file beats the detected key. */
function withTaggedKey(analysis: TrackAnalysis, track: Track): TrackAnalysis {
  const tagged = keyFromTag(track.tagKey);
  return tagged ? { ...analysis, key: tagged } : analysis;
}
import '@/styles/index.css';

export function App() {
  const { state, actions } = useApp();

  const analyzeTrack = useCallback(
    async (track: Track & { _audioBuffer?: AudioBuffer }): Promise<Track> => {
      if (isElectronEnvironment()) {
        const cached = await getCachedAnalysis(track);

        if (cached) {
          const fingerprint = createFileFingerprint(track);
          const cacheKey = fingerprintToKey(fingerprint);
          const analysis = withTaggedKey(createAnalysisFromCache(cached, cacheKey), track);
          return {
            ...track,
            analysis,
            analysisStatus: 'complete',
          };
        }
      }

      actions.updateTrack({ ...track, analysisStatus: 'analyzing' });

      try {
        const audioBuffer = track._audioBuffer || (await decodeAudioFile(track.filePath));
        const result = await analyzeAudioBuffer(audioBuffer);

        const fingerprint = createFileFingerprint(track);
        const cacheKey = fingerprintToKey(fingerprint);

        const analysis = withTaggedKey(
          { ...result, analyzedAt: new Date().toISOString(), cacheKey },
          track,
        );

        if (isElectronEnvironment()) {
          await setCachedAnalysis(track, analysis);
        }

        return {
          ...track,
          analysis,
          analysisStatus: 'complete',
        };
      } catch (error) {
        console.error('Analysis failed:', error);
        return {
          ...track,
          analysisStatus: 'error',
        };
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
        const newFilePaths = filePaths.filter((p) => !existingPaths.has(p));

        for (const filePath of newFilePaths) {
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
        const newFiles = files.filter((f) => !existingNames.has(f.name));

        for (const file of newFiles) {
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
          // Browser mode: load from localStorage
          const stored = localStorage.getItem('djmix-library');
          if (stored) {
            savedTracks = JSON.parse(stored);
          }
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
              const waveformData = generateWaveformData(audioBuffer);
              const spectralWaveform = generateSpectralWaveform(audioBuffer);

              const current = isCurrentAnalysis(track.analysis);
              const hydratedTrack: Track = {
                ...track,
                waveformData,
                spectralWaveform,
                analysis: current ? track.analysis : null,
                analysisStatus: current ? 'complete' : 'pending',
              };
              loadedTracks.push(hydratedTrack);
            } catch (error) {
              console.error(`Failed to load track ${track.fileName}:`, error);
            }
          }

          // Add all tracks at once to avoid multiple state updates
          if (loadedTracks.length > 0) {
            tracksCountAfterLoadRef.current = loadedTracks.length;
            actions.addTracks(loadedTracks);
          }
        } else {
          // Browser mode: tracks already have waveform data stored
          // (or they need to be re-imported)
          const validTracks = savedTracks
            .filter((t) => t.waveformData)
            .map((t): Track =>
              isCurrentAnalysis(t.analysis) ? t : { ...t, analysis: null, analysisStatus: 'pending' },
            );
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

    // Don't save if we just loaded and somehow ended up with fewer tracks
    // This prevents overwriting the library with partial data
    if (state.tracks.length === 0 && tracksCountAfterLoadRef.current > 0) {
      return;
    }

    // Debounce saves
    const timeoutId = setTimeout(() => {
      if (isElectronEnvironment()) {
        window.electronAPI.librarySave(state.tracks);
      } else {
        // Browser mode: save to localStorage (without large waveform data for some tracks)
        try {
          const tracksToSave = state.tracks.map((track) => ({
            ...track,
            // Keep waveform data in browser mode since we can't reload files
          }));
          localStorage.setItem('djmix-library', JSON.stringify(tracksToSave));
        } catch (error) {
          console.error('Failed to save library to localStorage:', error);
        }
      }
      console.log('Library saved:', state.tracks.length, 'tracks');
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [state.tracks, isLibraryReady]);

  return (
    <div className="app">
      <header className="header">
        <h1>DJ Mix</h1>
        <span className="bpm-label">{state.tracks.length} tracks loaded</span>
      </header>

      <main className="main-content">
        <div className="decks-section">
          <div className="decks-container">
            <Deck
              id="A"
              state={state.deckA}
              otherDeckHasBpm={!!state.deckB.track?.analysis?.bpm}
              onPlayPause={() => actions.playPauseDeck('A')}
              onSeek={(time) => actions.seekDeck('A', time)}
              onTargetBpmChange={(bpm) => actions.setDeckTargetBpm('A', bpm)}
              onSync={() => actions.syncToTarget('A')}
              onModeChange={(mode) => actions.setDeckMode('A', mode)}
              onPitchChange={(rate) => actions.setDeckPitch('A', rate)}
              onOverridesChange={actions.setTrackOverrides}
            />

            <Mixer
              channelA={{ eq: state.deckA.eq, filter: state.deckA.filter }}
              channelB={{ eq: state.deckB.eq, filter: state.deckB.filter }}
              onEqChange={actions.setDeckEq}
              onFilterChange={actions.setDeckFilter}
              crossfader={state.crossfader}
              masterVolume={state.masterVolume}
              volumeA={state.deckA.playback.volume}
              volumeB={state.deckB.playback.volume}
              automixEnabled={state.automix.enabled}
              canTriggerAutomix={!!state.deckA.track?.analysis && !!state.deckB.track?.analysis}
              onCrossfaderChange={actions.setCrossfader}
              onMasterVolumeChange={actions.setMasterVolume}
              onVolumeAChange={(volume) => actions.setDeckVolume('A', volume)}
              onVolumeBChange={(volume) => actions.setDeckVolume('B', volume)}
              onAutomixToggle={() => actions.setAutomixEnabled(!state.automix.enabled)}
              onTriggerAutomix={actions.triggerAutomix}
            />

            <Deck
              id="B"
              state={state.deckB}
              otherDeckHasBpm={!!state.deckA.track?.analysis?.bpm}
              onPlayPause={() => actions.playPauseDeck('B')}
              onSeek={(time) => actions.seekDeck('B', time)}
              onTargetBpmChange={(bpm) => actions.setDeckTargetBpm('B', bpm)}
              onSync={() => actions.syncToTarget('B')}
              onModeChange={(mode) => actions.setDeckMode('B', mode)}
              onPitchChange={(rate) => actions.setDeckPitch('B', rate)}
              onOverridesChange={actions.setTrackOverrides}
            />
          </div>
        </div>

        <TrackLibrary
          tracks={state.tracks}
          sortOption={state.sortOption}
          filterOptions={state.filterOptions}
          referenceTrackId={state.referenceTrackId}
          onImport={handleImport}
          onSortChange={actions.setSort}
          onFilterChange={actions.setFilter}
          onLoadToDeckA={(track) => actions.loadToDeck('A', track)}
          onLoadToDeckB={(track) => actions.loadToDeck('B', track)}
          onSetReference={actions.setReferenceTrack}
        />
      </main>

      <footer className="status-bar">
        <span>
          Deck A: {state.deckA.track?.fileName || 'Empty'} | Deck B:{' '}
          {state.deckB.track?.fileName || 'Empty'}
        </span>
        {state.automix.status ? (
          <span className="automix-status" title={state.automix.status}>
            {state.automix.status}
          </span>
        ) : (
          <span>Crossfader: {Math.round(state.crossfader * 100)}%</span>
        )}
      </footer>
    </div>
  );
}
