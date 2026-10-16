import React, { createContext, useContext, useReducer, useCallback } from 'react';
import type { Track, DeckState, EqBand, PlaybackMode, SortOption, FilterOptions } from '@/types';
import {
  loadTrackToDeck,
  loadAudioBufferToDeck,
  playDeck,
  seekDeck,
  setDeckTimeUpdateCallback,
  setDeckEndedCallback,
  syncDeckToTargetBpm,
  setDeckPlaybackMode,
  setDeckPlaybackRate,
  isDeckEnginePlaying,
  forceStopDeck,
} from '@/audio/playbackEngine';
import { isElectronEnvironment } from '@/audio/fileImporter';
import {
  setChannelFader,
  setCrossfader,
  setDeckAutoGain,
  setDeckEq,
  setDeckFilter,
  setMasterVolume,
} from '@/audio/mixingEngine';
import { cancelTransition, describePlan, startAutomixTransition } from '@/audio/automixController';

interface AppState {
  tracks: Track[];
  sortOption: SortOption;
  filterOptions: FilterOptions;
  deckA: DeckState;
  deckB: DeckState;
  crossfader: number;
  masterVolume: number;
  referenceTrackId: string | null;
  automix: {
    enabled: boolean;
    isTransitioning: boolean;
    activeDeck: 'A' | 'B' | null;
    /** What the last transition plan does, for the status bar. */
    status: string | null;
  };
}

type Action =
  | { type: 'ADD_TRACKS'; tracks: Track[] }
  | { type: 'UPDATE_TRACK'; track: Track }
  | { type: 'REMOVE_TRACK'; trackId: string }
  | { type: 'SET_SORT'; sortOption: SortOption }
  | { type: 'SET_FILTER'; filterOptions: FilterOptions }
  | { type: 'SET_DECK_TRACK'; deck: 'A' | 'B'; track: Track | null }
  | { type: 'SET_DECK_PLAYING'; deck: 'A' | 'B'; isPlaying: boolean }
  | { type: 'SET_DECK_TIME'; deck: 'A' | 'B'; currentTime: number }
  | { type: 'SET_DECK_PLAYBACK_RATE'; deck: 'A' | 'B'; rate: number }
  | { type: 'SET_DECK_TARGET_BPM'; deck: 'A' | 'B'; targetBpm: number | null }
  | { type: 'SET_DECK_MODE'; deck: 'A' | 'B'; mode: PlaybackMode }
  | { type: 'SET_DECK_VOLUME'; deck: 'A' | 'B'; volume: number }
  | { type: 'SET_DECK_EQ'; deck: 'A' | 'B'; band: EqBand; value: number }
  | { type: 'SET_DECK_FILTER'; deck: 'A' | 'B'; value: number }
  | { type: 'SET_CROSSFADER'; value: number }
  | { type: 'SET_MASTER_VOLUME'; volume: number }
  | { type: 'SET_REFERENCE_TRACK'; trackId: string | null }
  | { type: 'SET_AUTOMIX_ENABLED'; enabled: boolean }
  | { type: 'SET_AUTOMIX_TRANSITIONING'; isTransitioning: boolean }
  | { type: 'SET_AUTOMIX_ACTIVE_DECK'; deck: 'A' | 'B' | null }
  | { type: 'SET_AUTOMIX_STATUS'; status: string | null };

const createInitialDeckState = (): DeckState => ({
  track: null,
  playback: {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    volume: 1,
  },
  targetBpm: null,
  playbackMode: 'rate',
  eq: { low: 0, mid: 0, high: 0 },
  filter: 0,
});

const initialState: AppState = {
  tracks: [],
  sortOption: { field: 'fileName', direction: 'asc' },
  filterOptions: {},
  deckA: createInitialDeckState(),
  deckB: createInitialDeckState(),
  crossfader: 0,
  masterVolume: 1,
  referenceTrackId: null,
  automix: {
    enabled: false,
    isTransitioning: false,
    activeDeck: null,
    status: null,
  },
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ADD_TRACKS':
      return { ...state, tracks: [...state.tracks, ...action.tracks] };

    case 'UPDATE_TRACK':
      return {
        ...state,
        tracks: state.tracks.map((t) => (t.id === action.track.id ? action.track : t)),
      };

    case 'REMOVE_TRACK':
      return {
        ...state,
        tracks: state.tracks.filter((t) => t.id !== action.trackId),
      };

    case 'SET_SORT':
      return { ...state, sortOption: action.sortOption };

    case 'SET_FILTER':
      return { ...state, filterOptions: action.filterOptions };

    case 'SET_DECK_TRACK': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return {
        ...state,
        [deckKey]: {
          ...state[deckKey],
          track: action.track,
          playback: {
            ...state[deckKey].playback,
            currentTime: 0,
            duration: action.track?.duration || 0,
            isPlaying: false,
          },
        },
      };
    }

    case 'SET_DECK_PLAYING': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return {
        ...state,
        [deckKey]: {
          ...state[deckKey],
          playback: { ...state[deckKey].playback, isPlaying: action.isPlaying },
        },
      };
    }

    case 'SET_DECK_TIME': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return {
        ...state,
        [deckKey]: {
          ...state[deckKey],
          playback: { ...state[deckKey].playback, currentTime: action.currentTime },
        },
      };
    }

    case 'SET_DECK_PLAYBACK_RATE': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return {
        ...state,
        [deckKey]: {
          ...state[deckKey],
          playback: { ...state[deckKey].playback, playbackRate: action.rate },
        },
      };
    }

    case 'SET_DECK_TARGET_BPM': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return {
        ...state,
        [deckKey]: {
          ...state[deckKey],
          targetBpm: action.targetBpm,
        },
      };
    }

    case 'SET_DECK_MODE': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return {
        ...state,
        [deckKey]: {
          ...state[deckKey],
          playbackMode: action.mode,
        },
      };
    }

    case 'SET_DECK_VOLUME': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return {
        ...state,
        [deckKey]: {
          ...state[deckKey],
          playback: { ...state[deckKey].playback, volume: action.volume },
        },
      };
    }

    case 'SET_DECK_EQ': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return {
        ...state,
        [deckKey]: { ...state[deckKey], eq: { ...state[deckKey].eq, [action.band]: action.value } },
      };
    }

    case 'SET_DECK_FILTER': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return { ...state, [deckKey]: { ...state[deckKey], filter: action.value } };
    }

    case 'SET_CROSSFADER':
      return { ...state, crossfader: action.value };

    case 'SET_MASTER_VOLUME':
      return { ...state, masterVolume: action.volume };

    case 'SET_REFERENCE_TRACK':
      return { ...state, referenceTrackId: action.trackId };

    case 'SET_AUTOMIX_ENABLED':
      return {
        ...state,
        automix: { ...state.automix, enabled: action.enabled },
      };

    case 'SET_AUTOMIX_TRANSITIONING':
      return {
        ...state,
        automix: { ...state.automix, isTransitioning: action.isTransitioning },
      };

    case 'SET_AUTOMIX_ACTIVE_DECK':
      return {
        ...state,
        automix: { ...state.automix, activeDeck: action.deck },
      };

    case 'SET_AUTOMIX_STATUS':
      return { ...state, automix: { ...state.automix, status: action.status } };

    default:
      return state;
  }
}

interface AppContextValue {
  state: AppState;
  actions: {
    addTracks: (tracks: Track[]) => void;
    updateTrack: (track: Track) => void;
    removeTrack: (trackId: string) => void;
    setSort: (sortOption: SortOption) => void;
    setFilter: (filterOptions: FilterOptions) => void;
    loadToDeck: (deck: 'A' | 'B', track: Track) => Promise<void>;
    playPauseDeck: (deck: 'A' | 'B') => void;
    seekDeck: (deck: 'A' | 'B', time: number) => void;
    setDeckTargetBpm: (deck: 'A' | 'B', bpm: number | null) => void;
    setDeckMode: (deck: 'A' | 'B', mode: PlaybackMode) => void;
    setDeckVolume: (deck: 'A' | 'B', volume: number) => void;
    setDeckEq: (deck: 'A' | 'B', band: EqBand, value: number) => void;
    setDeckFilter: (deck: 'A' | 'B', value: number) => void;
    setDeckPitch: (deck: 'A' | 'B', rate: number) => void;
    setCrossfader: (value: number) => void;
    setMasterVolume: (volume: number) => void;
    setReferenceTrack: (trackId: string | null) => void;
    syncToTarget: (deck: 'A' | 'B') => void;
    setAutomixEnabled: (enabled: boolean) => void;
    triggerAutomix: () => void;
  };
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const actions: AppContextValue['actions'] = {
    addTracks: useCallback((tracks: Track[]) => {
      dispatch({ type: 'ADD_TRACKS', tracks });
    }, []),

    updateTrack: useCallback((track: Track) => {
      dispatch({ type: 'UPDATE_TRACK', track });
    }, []),

    removeTrack: useCallback((trackId: string) => {
      dispatch({ type: 'REMOVE_TRACK', trackId });
    }, []),

    setSort: useCallback((sortOption: SortOption) => {
      dispatch({ type: 'SET_SORT', sortOption });
    }, []),

    setFilter: useCallback((filterOptions: FilterOptions) => {
      dispatch({ type: 'SET_FILTER', filterOptions });
    }, []),

    loadToDeck: useCallback(
      async (deck: 'A' | 'B', track: Track & { _audioBuffer?: AudioBuffer }) => {
        if (isElectronEnvironment()) {
          await loadTrackToDeck(deck, track.filePath);
        } else if (track._audioBuffer) {
          await loadAudioBufferToDeck(deck, track._audioBuffer);
        }

        // Reset playback rate to 1 when loading a new track
        setDeckPlaybackRate(deck, 1);
        setDeckAutoGain(deck, track.analysis?.loudness.integratedLufs);
        dispatch({ type: 'SET_DECK_PLAYBACK_RATE', deck, rate: 1 });
        dispatch({ type: 'SET_DECK_TRACK', deck, track });

        setDeckTimeUpdateCallback(deck, (time) => {
          dispatch({ type: 'SET_DECK_TIME', deck, currentTime: time });
        });

        setDeckEndedCallback(deck, () => {
          dispatch({ type: 'SET_DECK_PLAYING', deck, isPlaying: false });
        });
      },
      [],
    ),

    playPauseDeck: useCallback((deck: 'A' | 'B') => {
      // Check ACTUAL engine state, not just React state
      if (isDeckEnginePlaying(deck)) {
        forceStopDeck(deck);
        dispatch({ type: 'SET_DECK_PLAYING', deck, isPlaying: false });
      } else if (playDeck(deck)) {
        dispatch({ type: 'SET_DECK_PLAYING', deck, isPlaying: true });
      }
    }, []),

    seekDeck: useCallback((deck: 'A' | 'B', time: number) => {
      seekDeck(deck, time);
      dispatch({ type: 'SET_DECK_TIME', deck, currentTime: time });
    }, []),

    setDeckTargetBpm: useCallback((deck: 'A' | 'B', bpm: number | null) => {
      dispatch({ type: 'SET_DECK_TARGET_BPM', deck, targetBpm: bpm });
    }, []),

    setDeckMode: useCallback((deck: 'A' | 'B', mode: PlaybackMode) => {
      setDeckPlaybackMode(deck, mode);
      dispatch({ type: 'SET_DECK_MODE', deck, mode });
    }, []),

    setDeckVolume: useCallback((deck: 'A' | 'B', volume: number) => {
      setChannelFader(deck, volume);
      dispatch({ type: 'SET_DECK_VOLUME', deck, volume });
    }, []),

    setDeckEq: useCallback((deck: 'A' | 'B', band: EqBand, value: number) => {
      setDeckEq(deck, band, value);
      dispatch({ type: 'SET_DECK_EQ', deck, band, value });
    }, []),

    setDeckFilter: useCallback((deck: 'A' | 'B', value: number) => {
      setDeckFilter(deck, value);
      dispatch({ type: 'SET_DECK_FILTER', deck, value });
    }, []),

    setDeckPitch: useCallback((deck: 'A' | 'B', rate: number) => {
      setDeckPlaybackRate(deck, rate);
      dispatch({ type: 'SET_DECK_PLAYBACK_RATE', deck, rate });
    }, []),

    setCrossfader: useCallback((value: number) => {
      // Grabbing the crossfader takes over from a running automix transition
      if (cancelTransition()) {
        dispatch({ type: 'SET_AUTOMIX_TRANSITIONING', isTransitioning: false });
      }
      setCrossfader(value);
      dispatch({ type: 'SET_CROSSFADER', value });
    }, []),

    setMasterVolume: useCallback((volume: number) => {
      setMasterVolume(volume);
      dispatch({ type: 'SET_MASTER_VOLUME', volume });
    }, []),

    setReferenceTrack: useCallback((trackId: string | null) => {
      dispatch({ type: 'SET_REFERENCE_TRACK', trackId });
    }, []),

    syncToTarget: useCallback(
      (deck: 'A' | 'B') => {
        const deckState = deck === 'A' ? state.deckA : state.deckB;
        const otherDeckState = deck === 'A' ? state.deckB : state.deckA;
        const track = deckState.track;
        const otherTrack = otherDeckState.track;

        // Get source BPM from current deck
        if (!track?.analysis?.bpm) return;
        const sourceBpm = track.analysis.manualBpm || track.analysis.bpm;

        // Get target BPM from other deck's track, or fall back to manual targetBpm
        let targetBpm: number | null = null;
        if (otherTrack?.analysis?.bpm) {
          targetBpm = otherTrack.analysis.manualBpm || otherTrack.analysis.bpm;
        } else if (deckState.targetBpm) {
          targetBpm = deckState.targetBpm;
        }

        if (!targetBpm) return;

        syncDeckToTargetBpm(deck, sourceBpm, targetBpm);
        dispatch({ type: 'SET_DECK_PLAYBACK_RATE', deck, rate: targetBpm / sourceBpm });
      },
      [state.deckA, state.deckB],
    ),

    setAutomixEnabled: useCallback((enabled: boolean) => {
      dispatch({ type: 'SET_AUTOMIX_ENABLED', enabled });
    }, []),

    triggerAutomix: useCallback(() => {
      // The playing deck hands over to the other one (deck A when neither or both play).
      const sourceDeckId: 'A' | 'B' =
        state.deckB.playback.isPlaying && !state.deckA.playback.isPlaying ? 'B' : 'A';
      const targetDeckId: 'A' | 'B' = sourceDeckId === 'A' ? 'B' : 'A';
      const source = sourceDeckId === 'A' ? state.deckA : state.deckB;
      const target = targetDeckId === 'A' ? state.deckA : state.deckB;
      if (!source.track?.analysis || !target.track?.analysis) {
        dispatch({ type: 'SET_AUTOMIX_STATUS', status: 'Mix: both decks need an analysed track' });
        return;
      }

      if (!isDeckEnginePlaying(sourceDeckId)) {
        playDeck(sourceDeckId);
        dispatch({ type: 'SET_DECK_PLAYING', deck: sourceDeckId, isPlaying: true });
      }

      const plan = startAutomixTransition(sourceDeckId, source.track.analysis, target.track.analysis, {
        onOutgoingStopped: () => {
          dispatch({ type: 'SET_DECK_PLAYING', deck: sourceDeckId, isPlaying: false });
          dispatch({ type: 'SET_DECK_VOLUME', deck: sourceDeckId, volume: 1 });
          dispatch({ type: 'SET_DECK_FILTER', deck: sourceDeckId, value: 0 });
          for (const band of ['low', 'mid', 'high'] as const) {
            dispatch({ type: 'SET_DECK_EQ', deck: sourceDeckId, band, value: 0 });
          }
        },
        onFinished: () => {
          dispatch({ type: 'SET_AUTOMIX_TRANSITIONING', isTransitioning: false });
          dispatch({ type: 'SET_AUTOMIX_ACTIVE_DECK', deck: targetDeckId });
        },
        onTick: (rates) => {
          dispatch({ type: 'SET_DECK_PLAYBACK_RATE', deck: 'A', rate: rates.A });
          dispatch({ type: 'SET_DECK_PLAYBACK_RATE', deck: 'B', rate: rates.B });
        },
      });
      if (!plan) {
        dispatch({ type: 'SET_AUTOMIX_STATUS', status: 'Mix: could not start the transition' });
        return;
      }

      dispatch({ type: 'SET_CROSSFADER', value: 0 });
      dispatch({ type: 'SET_DECK_MODE', deck: 'A', mode: 'stretch' });
      dispatch({ type: 'SET_DECK_MODE', deck: 'B', mode: 'stretch' });
      dispatch({ type: 'SET_DECK_PLAYING', deck: targetDeckId, isPlaying: true });
      dispatch({ type: 'SET_AUTOMIX_TRANSITIONING', isTransitioning: true });
      dispatch({ type: 'SET_AUTOMIX_ACTIVE_DECK', deck: sourceDeckId });
      dispatch({ type: 'SET_AUTOMIX_STATUS', status: describePlan(plan) });
    }, [state.deckA, state.deckB]),
  };

  return <AppContext.Provider value={{ state, actions }}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
