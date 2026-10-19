import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, type TrackPatch } from '@/store/AppContext';
import { dedupeTracks } from '@/store/library';
import { Browser, Deck, Mixer, Settings } from '@/components';
import { BadMixButton } from '@/components/BadMixButton';
import { NextMix } from '@/components/NextMix';
import { SYNC_MODES } from '@/audio/engine/sync';
import { MIX_STYLES, type MixStyle } from '@/audio/mix/mixPoints';
import { loudnessTrimDb } from '@/audio/engine/curves';
import type { MixMarks } from '@/components/Waveform';
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
} from '@/audio';
import type { DeckState, SyncMode, Track, TrackAnalysis } from '@/types';
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

  // Returns a patch rather than the track: by the time the analysis is done, the copy it started
  // from may be stale (a waveform attached, a correction made).
  const analyzeTrack = useCallback(
    async (track: Track & { _audioBuffer?: AudioBuffer }): Promise<TrackPatch> => {
      if (isElectronEnvironment()) {
        const cached = await getCachedAnalysis(track);
        if (cached) {
          const fingerprint = createFileFingerprint(track);
          const cacheKey = fingerprintToKey(fingerprint);
          const analysis = withTaggedKey(createAnalysisFromCache(cached, cacheKey), track);
          return { id: track.id, analysis, analysisStatus: 'complete' };
        }
      }

      actions.updateTrack({ id: track.id, analysisStatus: 'analyzing' });

      try {
        const audioBuffer = track._audioBuffer || (await decodeAudioFile(track.filePath));
        const result = await analyzeAudioBuffer(audioBuffer, { bpm: track.tagBpm });
        const fingerprint = createFileFingerprint(track);
        const cacheKey = fingerprintToKey(fingerprint);
        const analysis = withTaggedKey({ ...result, analyzedAt: new Date().toISOString(), cacheKey }, track);
        if (isElectronEnvironment()) await setCachedAnalysis(track, analysis);
        return { id: track.id, analysis, analysisStatus: 'complete' };
      } catch (error) {
        console.error('Analysis failed:', error);
        return { id: track.id, analysisStatus: 'error' };
      }
    },
    [actions],
  );

  const [isLibraryReady, setIsLibraryReady] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const handleImport = useCallback(async () => {
    if (!isLibraryReady) return;
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
  }, [state.tracks, actions, isLibraryReady]);

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
        // Older builds appended re-imports; keep one entry per file, the richest copy.
        const unique = dedupeTracks(savedTracks);
        if (unique.length < savedTracks.length) {
          console.log(`Library: dropped ${savedTracks.length - unique.length} duplicate entries`);
        }
        savedTracks = unique;
        if (savedTracks.length === 0) {
          setIsLibraryReady(true);
          return;
        }

        if (isElectronEnvironment()) {
          // Nothing is decoded here: a deck fetches its waveform from the cache (or builds it
          // from the audio it decodes anyway) when the track is loaded.
          const loadedTracks = savedTracks.map((track): Track => {
            const current = isCurrentAnalysis(track.analysis);
            return {
              ...track,
              waveformData: undefined,
              spectralWaveform: undefined,
              analysis: current ? track.analysis : null,
              analysisStatus: current ? 'complete' : 'pending',
            };
          });
          tracksCountAfterLoadRef.current = loadedTracks.length;
          actions.addTracks(loadedTracks);
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

  // The next mix, in each deck's own bars, for the waveforms.
  const next = state.automix.next;
  const marksFor = (deck: 'A' | 'B'): MixMarks | null => {
    if (!next) return null;
    const track = (deck === 'A' ? state.deckA : state.deckB).track;
    const { plan } = next;
    if (next.outgoing === deck && track?.id === next.outgoingTrackId) {
      return {
        role: 'outgoing',
        startBar: plan.outgoingStartBar,
        overlapBars: plan.overlapBars,
        swapBar: plan.outgoingStartBar + plan.bassSwapBar,
        loop: plan.outgoingLoop,
        live: next.live,
      };
    }
    if (next.incoming === deck && track?.id === next.incomingTrackId) {
      // An intro loop plays some bars more than once: the overlap covers that many fewer of the track's.
      const intro = plan.incomingLoop;
      const repeated = intro ? intro.repeats * intro.bars : 0;
      return {
        role: 'incoming',
        startBar: plan.incomingStartBar,
        overlapBars: plan.overlapBars - repeated,
        swapBar: plan.incomingStartBar + plan.bassSwapBar - repeated,
        ...(intro ? { loop: { startBar: intro.startBar, bars: intro.bars, plays: intro.repeats + 1 } } : {}),
        live: next.live,
      };
    }
    return null;
  };
  const incomingTrack = next ? (next.incoming === 'A' ? state.deckA : state.deckB).track : null;
  const moved = !!next && !!state.automix.startBar && state.automix.startBar.trackId === next.outgoingTrackId;

  const channelFor = (deck: DeckState) => ({
    eq: deck.eq,
    filter: deck.filter,
    volume: deck.playback.volume,
    trimDb: deck.trimDb,
    autoTrimDb: loudnessTrimDb(deck.track?.analysis?.loudness.integratedLufs),
    fx: deck.fx,
  });
  const loopHandlers = (deck: 'A' | 'B') => ({
    onLoop: (beats: number) => actions.setDeckLoop(deck, beats),
    onLoopIn: () => actions.loopIn(deck),
    onLoopOut: () => actions.loopOut(deck),
    onLoopHalve: () => actions.loopHalve(deck),
    onLoopDouble: () => actions.loopDouble(deck),
    onLoopToggle: () => actions.loopToggle(deck),
  });

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
        <label className="topbar-sync" title="What SYNC lines up: the tempo only, or also the beat, the bar or the phrase">
          <span>SYNC</span>
          <select value={state.syncMode} onChange={(e) => actions.setSyncMode(e.target.value as SyncMode)}>
            {SYNC_MODES.map(({ mode, label }) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="topbar-sync"
          title="How the next track comes in. Blend: the tracks overlap as they are. Loop: the incoming track holds a sparse phrase of its intro (kick, no bassline) on a loop while it fades in, then plays on into its drop on the bass swap; the outgoing track loops its last phrase when that helps">
          <span>MIX</span>
          <select value={state.automix.style} onChange={(e) => actions.setMixStyle(e.target.value as MixStyle)}>
            {MIX_STYLES.map(({ style, label }) => (
              <option key={style} value={style}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <NextMix
          next={next}
          status={state.automix.status}
          autoEnabled={state.automix.enabled}
          incomingName={incomingTrack ? incomingTrack.title || incomingTrack.fileName : null}
          moved={moved}
          onEarlier={() => actions.nudgeMixStart(-8)}
          onLater={() => actions.nudgeMixStart(8)}
          onReset={actions.resetMixStart}
          onSkip={actions.skipNext}
        />
        <span className="topbar-meta">
          {analysing > 0 ? `Analysing ${analysing} of ${state.tracks.length}` : `${state.tracks.length} tracks`}
        </span>
        <button className="nextmix-btn" onClick={() => setShowSettings(true)} title="Audio output, sample rate and buffer">
          AUDIO
        </button>
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
          mixMarks={marksFor('A')}
          syncMode={state.syncMode}
          {...loopHandlers('A')}
        />

        <Mixer
          channelA={channelFor(state.deckA)}
          channelB={channelFor(state.deckB)}
          onEqChange={actions.setDeckEq}
          onFilterChange={actions.setDeckFilter}
          onVolumeChange={actions.setDeckVolume}
          crossfader={state.crossfader}
          onCrossfaderChange={actions.setCrossfader}
          masterVolume={state.masterVolume}
          onMasterVolumeChange={actions.setMasterVolume}
          onTrimChange={actions.setDeckTrim}
          onFxChange={actions.setDeckFx}
          crossfaderCurve={state.crossfaderCurve}
          onCrossfaderCurveChange={actions.setCrossfaderCurve}
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
          mixMarks={marksFor('B')}
          syncMode={state.syncMode}
          {...loopHandlers('B')}
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
        canImport={isLibraryReady}
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
          <BadMixButton />
        </span>
      </footer>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
