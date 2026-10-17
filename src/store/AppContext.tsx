import React, { createContext, useContext, useReducer, useCallback, useRef } from 'react';
import type { AnalysisOverrides, Track, DeckState, EqBand, PlaybackMode, SortOption, FilterOptions } from '@/types';
import { effectiveAnalysis } from '@/audio/analysis/overrides';
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
import { orderSet, sequencerTrackFromAnalysis, type TempoDirection } from '@/audio/mix/sequencer';
import type { MixTiming } from '@/audio/mix/mixPoints';
import { eqDbToGain } from '@/audio/mix/templates';
import { eqGainToKnob } from '@/audio/engine/curves';

interface AppState {
  tracks: Track[];
  sortOption: SortOption;
  filterOptions: FilterOptions;
  deckA: DeckState;
  deckB: DeckState;
  crossfader: number;
  masterVolume: number;
  referenceTrackId: string | null;
  /** Track ids automix plays next, in order. */
  queue: string[];
  /** Track ids already played this session; automix won't repeat them. */
  played: string[];
  automix: {
    enabled: boolean;
    isTransitioning: boolean;
    activeDeck: 'A' | 'B' | null;
    /** What the last transition plan does, for the status bar. */
    status: string | null;
    /** Which way the set's tempo travels when automix orders or picks tracks. */
    direction: TempoDirection;
  };
}

type Action =
  | { type: 'ADD_TRACKS'; tracks: Track[] }
  | { type: 'UPDATE_TRACK'; track: Track }
  | { type: 'SET_TRACK_OVERRIDES'; trackId: string; overrides: AnalysisOverrides | undefined }
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
  | { type: 'SET_DECK_CUE'; deck: 'A' | 'B'; cuePoint: number | null }
  | { type: 'SET_DECK_EQ'; deck: 'A' | 'B'; band: EqBand; value: number }
  | { type: 'SET_DECK_FILTER'; deck: 'A' | 'B'; value: number }
  | { type: 'SET_CROSSFADER'; value: number }
  | { type: 'SET_MASTER_VOLUME'; volume: number }
  | { type: 'SET_REFERENCE_TRACK'; trackId: string | null }
  | { type: 'SET_AUTOMIX_ENABLED'; enabled: boolean }
  | { type: 'SET_AUTOMIX_TRANSITIONING'; isTransitioning: boolean }
  | { type: 'SET_AUTOMIX_ACTIVE_DECK'; deck: 'A' | 'B' | null }
  | { type: 'SET_AUTOMIX_STATUS'; status: string | null }
  | { type: 'SET_AUTOMIX_DIRECTION'; direction: TempoDirection }
  | { type: 'SET_QUEUE'; queue: string[] }
  | { type: 'MARK_PLAYED'; trackId: string };

const createInitialDeckState = (): DeckState => ({
  track: null,
  playback: {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    volume: 1,
  },
  cuePoint: null,
  targetBpm: null,
  playbackMode: 'rate',
  eq: { low: 0, mid: 0, high: 0 },
  filter: 0,
});

const initialState: AppState = {
  tracks: [],
  sortOption: { field: 'title', direction: 'asc' },
  filterOptions: {},
  deckA: createInitialDeckState(),
  deckB: createInitialDeckState(),
  crossfader: 0,
  masterVolume: 1,
  referenceTrackId: null,
  queue: [],
  played: [],
  automix: {
    enabled: false,
    isTransitioning: false,
    activeDeck: null,
    status: null,
    direction: 'up',
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

    case 'SET_TRACK_OVERRIDES': {
      // Decks hold their own copy of the track: update it too so they redraw at once.
      const withOverrides = (t: Track): Track =>
        t.id === action.trackId ? { ...t, overrides: action.overrides } : t;
      const deck = (d: DeckState): DeckState => (d.track ? { ...d, track: withOverrides(d.track) } : d);
      return {
        ...state,
        tracks: state.tracks.map(withOverrides),
        deckA: deck(state.deckA),
        deckB: deck(state.deckB),
      };
    }

    case 'REMOVE_TRACK':
      return {
        ...state,
        tracks: state.tracks.filter((t) => t.id !== action.trackId),
        queue: state.queue.filter((id) => id !== action.trackId),
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
          cuePoint: null,
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

    case 'SET_DECK_CUE': {
      const deckKey = action.deck === 'A' ? 'deckA' : 'deckB';
      return { ...state, [deckKey]: { ...state[deckKey], cuePoint: action.cuePoint } };
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

    case 'SET_AUTOMIX_DIRECTION':
      return { ...state, automix: { ...state.automix, direction: action.direction } };

    case 'SET_QUEUE':
      return { ...state, queue: action.queue };

    case 'MARK_PLAYED':
      return state.played.includes(action.trackId)
        ? state
        : { ...state, played: [...state.played, action.trackId] };

    default:
      return state;
  }
}

interface AppContextValue {
  state: AppState;
  actions: {
    addTracks: (tracks: Track[]) => void;
    updateTrack: (track: Track) => void;
    /** Stores the user's analysis corrections on the library track and any deck copy of it. */
    setTrackOverrides: (trackId: string, overrides: AnalysisOverrides | undefined) => void;
    removeTrack: (trackId: string) => void;
    setSort: (sortOption: SortOption) => void;
    setFilter: (filterOptions: FilterOptions) => void;
    loadToDeck: (deck: 'A' | 'B', track: Track) => Promise<void>;
    playPauseDeck: (deck: 'A' | 'B') => void;
    /** CUE: playing → back to the cue point and pause; paused → set the cue point here. */
    pressCue: (deck: 'A' | 'B') => void;
    /** Parks a deck on a cue point (Auto cueing the next track); doesn't take over from automix. */
    cueDeckAt: (deck: 'A' | 'B', time: number) => void;
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
    setAutomixStatus: (status: string | null) => void;
    /** 'now': at the next 16/32-bar entry (Mix now). 'end': where the playing track runs out (Auto). */
    triggerAutomix: (timing?: MixTiming) => void;
    /** Hands control back to the user (see releaseAutomix). */
    releaseAutomix: (reason: string) => void;
    addToQueue: (trackId: string) => void;
    removeFromQueue: (trackId: string) => void;
    moveInQueue: (trackId: string, offset: number) => void;
    /** Orders the queue for the set's direction, continuing from the playing track. */
    smartOrderQueue: () => void;
    setAutomixDirection: (direction: TempoDirection) => void;
    markPlayed: (trackId: string) => void;
  };
}

const AppContext = createContext<AppContextValue | null>(null);

/** Smallest change worth re-rendering for while automix moves a control. */
const LIVE_CONTROL_STEP = 0.01;
const LIVE_RATE_STEP = 1e-4;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Any manual control move takes over from automix: the running transition stops, every
   * engine control goes back to what its knob shows, a deck that hadn't come in yet is
   * stopped, and Auto turns off so it doesn't immediately start another one.
   */
  const releaseAutomix = useCallback((reason: string) => {
    const cancelled = cancelTransition();
    if (!cancelled) return;
    const current = stateRef.current;
    for (const id of ['A', 'B'] as const) {
      const deck = id === 'A' ? current.deckA : current.deckB;
      setChannelFader(id, deck.playback.volume);
      for (const band of ['low', 'mid', 'high'] as const) setDeckEq(id, band, deck.eq[band]);
      setDeckFilter(id, deck.filter);
    }
    if (!cancelled.incomingStarted) {
      // Nothing of it was heard: stop it and give it back neutral.
      const id = cancelled.incomingId;
      forceStopDeck(id);
      dispatch({ type: 'SET_DECK_PLAYING', deck: id, isPlaying: false });
      setChannelFader(id, 1);
      dispatch({ type: 'SET_DECK_VOLUME', deck: id, volume: 1 });
      for (const band of ['low', 'mid', 'high'] as const) {
        setDeckEq(id, band, 0);
        dispatch({ type: 'SET_DECK_EQ', deck: id, band, value: 0 });
      }
      setDeckFilter(id, 0);
      dispatch({ type: 'SET_DECK_FILTER', deck: id, value: 0 });
    }
    dispatch({ type: 'SET_AUTOMIX_TRANSITIONING', isTransitioning: false });
    dispatch({ type: 'SET_AUTOMIX_ENABLED', enabled: false });
    dispatch({ type: 'SET_AUTOMIX_STATUS', status: `Automix stopped: ${reason}` });
  }, []);

  const actions: AppContextValue['actions'] = {
    addTracks: useCallback((tracks: Track[]) => {
      dispatch({ type: 'ADD_TRACKS', tracks });
    }, []),

    updateTrack: useCallback((track: Track) => {
      dispatch({ type: 'UPDATE_TRACK', track });
    }, []),

    setTrackOverrides: useCallback((trackId: string, overrides: AnalysisOverrides | undefined) => {
      dispatch({ type: 'SET_TRACK_OVERRIDES', trackId, overrides });
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
        releaseAutomix(`deck ${deck} loaded`);
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
      [releaseAutomix],
    ),

    playPauseDeck: useCallback((deck: 'A' | 'B') => {
      releaseAutomix(`deck ${deck} play/pause`);
      // Check ACTUAL engine state, not just React state
      if (isDeckEnginePlaying(deck)) {
        forceStopDeck(deck);
        dispatch({ type: 'SET_DECK_PLAYING', deck, isPlaying: false });
      } else if (playDeck(deck)) {
        dispatch({ type: 'SET_DECK_PLAYING', deck, isPlaying: true });
      }
    }, [releaseAutomix]),

    pressCue: useCallback((deck: 'A' | 'B') => {
      const deckState = deck === 'A' ? stateRef.current.deckA : stateRef.current.deckB;
      if (!deckState.track) return;
      if (isDeckEnginePlaying(deck)) {
        releaseAutomix(`deck ${deck} cued`);
        forceStopDeck(deck);
        dispatch({ type: 'SET_DECK_PLAYING', deck, isPlaying: false });
        const cue = deckState.cuePoint ?? 0;
        seekDeck(deck, cue);
        dispatch({ type: 'SET_DECK_TIME', deck, currentTime: cue });
      } else {
        dispatch({ type: 'SET_DECK_CUE', deck, cuePoint: deckState.playback.currentTime });
      }
    }, [releaseAutomix]),

    cueDeckAt: useCallback((deck: 'A' | 'B', time: number) => {
      if (isDeckEnginePlaying(deck)) return;
      seekDeck(deck, time);
      dispatch({ type: 'SET_DECK_TIME', deck, currentTime: time });
      dispatch({ type: 'SET_DECK_CUE', deck, cuePoint: time });
    }, []),

    seekDeck: useCallback((deck: 'A' | 'B', time: number) => {
      releaseAutomix(`deck ${deck} moved`);
      seekDeck(deck, time);
      dispatch({ type: 'SET_DECK_TIME', deck, currentTime: time });
    }, [releaseAutomix]),

    setDeckTargetBpm: useCallback((deck: 'A' | 'B', bpm: number | null) => {
      dispatch({ type: 'SET_DECK_TARGET_BPM', deck, targetBpm: bpm });
    }, []),

    setDeckMode: useCallback((deck: 'A' | 'B', mode: PlaybackMode) => {
      releaseAutomix(`deck ${deck} mode changed`);
      setDeckPlaybackMode(deck, mode);
      dispatch({ type: 'SET_DECK_MODE', deck, mode });
    }, [releaseAutomix]),

    setDeckVolume: useCallback((deck: 'A' | 'B', volume: number) => {
      releaseAutomix(`deck ${deck} fader moved`);
      setChannelFader(deck, volume);
      dispatch({ type: 'SET_DECK_VOLUME', deck, volume });
    }, [releaseAutomix]),

    setDeckEq: useCallback((deck: 'A' | 'B', band: EqBand, value: number) => {
      releaseAutomix(`deck ${deck} EQ moved`);
      setDeckEq(deck, band, value);
      dispatch({ type: 'SET_DECK_EQ', deck, band, value });
    }, [releaseAutomix]),

    setDeckFilter: useCallback((deck: 'A' | 'B', value: number) => {
      releaseAutomix(`deck ${deck} filter moved`);
      setDeckFilter(deck, value);
      dispatch({ type: 'SET_DECK_FILTER', deck, value });
    }, [releaseAutomix]),

    setDeckPitch: useCallback((deck: 'A' | 'B', rate: number) => {
      releaseAutomix(`deck ${deck} pitch moved`);
      setDeckPlaybackRate(deck, rate);
      dispatch({ type: 'SET_DECK_PLAYBACK_RATE', deck, rate });
    }, [releaseAutomix]),

    setCrossfader: useCallback((value: number) => {
      releaseAutomix('crossfader moved');
      setCrossfader(value);
      dispatch({ type: 'SET_CROSSFADER', value });
    }, [releaseAutomix]),

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
        const sourceBpm = track && effectiveAnalysis(track)?.bpm;
        if (!sourceBpm) return;

        // Get target BPM from other deck's track, or fall back to manual targetBpm
        let targetBpm: number | null = null;
        const otherBpm = otherTrack && effectiveAnalysis(otherTrack)?.bpm;
        if (otherBpm) {
          targetBpm = otherBpm;
        } else if (deckState.targetBpm) {
          targetBpm = deckState.targetBpm;
        }

        if (!targetBpm) return;

        releaseAutomix(`deck ${deck} synced`);
        syncDeckToTargetBpm(deck, sourceBpm, targetBpm);
        dispatch({ type: 'SET_DECK_PLAYBACK_RATE', deck, rate: targetBpm / sourceBpm });
      },
      [state.deckA, state.deckB, releaseAutomix],
    ),

    setAutomixEnabled: useCallback((enabled: boolean) => {
      dispatch({ type: 'SET_AUTOMIX_ENABLED', enabled });
      if (!enabled) dispatch({ type: 'SET_AUTOMIX_STATUS', status: null });
    }, []),

    setAutomixStatus: useCallback((status: string | null) => {
      dispatch({ type: 'SET_AUTOMIX_STATUS', status });
    }, []),

    triggerAutomix: useCallback((timing: MixTiming = 'now') => {
      // The playing deck hands over to the other one (deck A when neither or both play).
      const sourceDeckId: 'A' | 'B' =
        state.deckB.playback.isPlaying && !state.deckA.playback.isPlaying ? 'B' : 'A';
      const targetDeckId: 'A' | 'B' = sourceDeckId === 'A' ? 'B' : 'A';
      const source = sourceDeckId === 'A' ? state.deckA : state.deckB;
      const target = targetDeckId === 'A' ? state.deckA : state.deckB;
      const sourceAnalysis = source.track && effectiveAnalysis(source.track);
      const targetAnalysis = target.track && effectiveAnalysis(target.track);
      if (!source.track || !sourceAnalysis || !targetAnalysis) {
        dispatch({ type: 'SET_AUTOMIX_STATUS', status: 'Mix: both decks need an analysed track' });
        return;
      }

      if (!isDeckEnginePlaying(sourceDeckId)) {
        playDeck(sourceDeckId);
        dispatch({ type: 'SET_DECK_PLAYING', deck: sourceDeckId, isPlaying: true });
      }

      const sourceTrackId = source.track.id;
      const deckFor = { outgoing: sourceDeckId, incoming: targetDeckId } as const;
      // Controls follow the automation in steps, so they only re-render when it really moves
      // them; values are snapped to the step, so lane end points land exactly.
      const shown = new Map<string, number>();
      const show = (key: string, value: number, step: number, apply: (value: number) => void) => {
        const snapped = Math.round(value / step) * step;
        if (shown.get(key) === snapped) return;
        shown.set(key, snapped);
        apply(snapped);
      };
      let outgoingStopped = false;
      const plan = startAutomixTransition(sourceDeckId, sourceAnalysis, targetAnalysis, timing, {
        onIncomingStarted: () => {
          dispatch({ type: 'SET_DECK_PLAYING', deck: targetDeckId, isPlaying: true });
        },
        onOutgoingStopped: () => {
          outgoingStopped = true;
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
          dispatch({ type: 'MARK_PLAYED', trackId: sourceTrackId });
          dispatch({ type: 'SET_AUTOMIX_STATUS', status: `Mixed into ${target.track?.title || target.track?.fileName}` });
        },
        onTick: (rates, lanes) => {
          for (const deck of ['A', 'B'] as const) {
            show(`${deck}.rate`, rates[deck], LIVE_RATE_STEP, (rate) =>
              dispatch({ type: 'SET_DECK_PLAYBACK_RATE', deck, rate }),
            );
          }
          // Once the outgoing deck has stopped its controls are back at neutral; leave them.
          const targets = outgoingStopped ? (['incoming'] as const) : (['outgoing', 'incoming'] as const);
          for (const target of targets) {
            const deck = deckFor[target];
            for (const [control, value] of Object.entries(lanes[target])) {
              if (value === undefined) continue;
              if (control === 'fader') {
                show(`${deck}.fader`, value, LIVE_CONTROL_STEP, (volume) =>
                  dispatch({ type: 'SET_DECK_VOLUME', deck, volume }),
                );
              } else if (control === 'filter') {
                show(`${deck}.filter`, value, LIVE_CONTROL_STEP, (filter) =>
                  dispatch({ type: 'SET_DECK_FILTER', deck, value: filter }),
                );
              } else {
                const band = control as EqBand;
                show(`${deck}.${band}`, eqGainToKnob(eqDbToGain(value)), LIVE_CONTROL_STEP, (knob) =>
                  dispatch({ type: 'SET_DECK_EQ', deck, band, value: knob }),
                );
              }
            }
          }
        },
      });
      if (!plan) {
        dispatch({ type: 'SET_AUTOMIX_STATUS', status: 'Mix: could not start the transition' });
        return;
      }

      dispatch({ type: 'SET_CROSSFADER', value: 0 });
      dispatch({ type: 'SET_DECK_MODE', deck: 'A', mode: 'stretch' });
      dispatch({ type: 'SET_DECK_MODE', deck: 'B', mode: 'stretch' });
      dispatch({ type: 'SET_AUTOMIX_TRANSITIONING', isTransitioning: true });
      dispatch({ type: 'SET_AUTOMIX_ACTIVE_DECK', deck: sourceDeckId });
      dispatch({ type: 'SET_AUTOMIX_STATUS', status: describePlan(plan) });
    }, [state.deckA, state.deckB]),

    releaseAutomix,

    addToQueue: useCallback(
      (trackId: string) => {
        if (!state.queue.includes(trackId)) dispatch({ type: 'SET_QUEUE', queue: [...state.queue, trackId] });
      },
      [state.queue],
    ),

    removeFromQueue: useCallback(
      (trackId: string) => dispatch({ type: 'SET_QUEUE', queue: state.queue.filter((id) => id !== trackId) }),
      [state.queue],
    ),

    moveInQueue: useCallback(
      (trackId: string, offset: number) => {
        const from = state.queue.indexOf(trackId);
        const to = Math.max(0, Math.min(state.queue.length - 1, from + offset));
        if (from < 0 || from === to) return;
        const queue = [...state.queue];
        queue.splice(to, 0, queue.splice(from, 1)[0]);
        dispatch({ type: 'SET_QUEUE', queue });
      },
      [state.queue],
    ),

    smartOrderQueue: useCallback(() => {
      const byId = new Map(state.tracks.map((t) => [t.id, t]));
      const playing = [state.deckA, state.deckB].find((d) => d.playback.isPlaying)?.track;
      const ids = state.queue.filter((id) => byId.get(id)?.analysis);
      const unanalysed = state.queue.filter((id) => !byId.get(id)?.analysis);
      const startId = playing?.analysis && !ids.includes(playing.id) ? playing.id : undefined;
      const candidates = [...(startId ? [startId] : []), ...ids].map((id) =>
        sequencerTrackFromAnalysis(id, effectiveAnalysis(byId.get(id)!)!),
      );
      const order = orderSet(candidates, { startId, direction: state.automix.direction });
      const ordered = order.tracks.map((t) => t.id).filter((id) => id !== startId);
      dispatch({ type: 'SET_QUEUE', queue: [...ordered, ...unanalysed] });
    }, [state.tracks, state.queue, state.deckA, state.deckB, state.automix.direction]),

    setAutomixDirection: useCallback((direction: TempoDirection) => {
      dispatch({ type: 'SET_AUTOMIX_DIRECTION', direction });
    }, []),

    markPlayed: useCallback((trackId: string) => {
      dispatch({ type: 'MARK_PLAYED', trackId });
    }, []),
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
