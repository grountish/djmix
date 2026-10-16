import { useEffect, useRef } from 'react';
import { effectiveAnalysis } from '@/audio/analysis/overrides';
import { describePlan, previewTransition, secondsUntilPlan } from '@/audio/automixController';
import { sequencerTrackFromAnalysis, suggestNext } from '@/audio/mix/sequencer';
import type { DeckState, Track } from '@/types';
import { useApp } from './AppContext';

type DeckId = 'A' | 'B';

/** Auto arms a transition this long before its first audible change (the tempo ramp). */
const ARM_AHEAD_SECONDS = 25;
const CHECK_INTERVAL_MS = 1000;

interface AutoDecks {
  current: { id: DeckId; track: Track };
  idle: { id: DeckId; deck: DeckState };
  used: Set<string>;
}

/** The playing deck and the idle one, when exactly one deck plays. */
function autoDecks(deckA: DeckState, deckB: DeckState, played: string[]): AutoDecks | null {
  const decks = [
    { id: 'A' as DeckId, deck: deckA },
    { id: 'B' as DeckId, deck: deckB },
  ];
  const playing = decks.filter((d) => d.deck.playback.isPlaying);
  if (playing.length !== 1 || !playing[0].deck.track) return null;
  const current = { id: playing[0].id, track: playing[0].deck.track };
  return {
    current,
    idle: decks.find((d) => d.id !== current.id)!,
    used: new Set([...played, current.track.id]),
  };
}

function formatWait(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Auto DJ: plays the set hands-off. It starts the loaded deck, keeps the next track (the
 * queue's head, else the library's best match) cued on the idle deck, and arms each transition
 * shortly before it is due — until then the idle deck is left alone and the status bar counts
 * down to the next mix.
 */
export function useAutoDj(): void {
  const { state, actions } = useApp();
  const latest = useRef({ state, actions });
  latest.current = { state, actions };
  const armedFor = useRef<string | null>(null);
  const busy = useRef(false);

  // Start the set and keep the next track cued.
  useEffect(() => {
    if (!state.automix.enabled || state.automix.isTransitioning || busy.current) return;
    const played = new Set(state.played);
    const bothIdle = !state.deckA.playback.isPlaying && !state.deckB.playback.isPlaying;
    if (bothIdle) {
      const ready = (['A', 'B'] as const).find((id) => {
        const track = (id === 'A' ? state.deckA : state.deckB).track;
        return track && !played.has(track.id) && track.analysis;
      });
      if (ready) actions.playPauseDeck(ready);
      return;
    }

    const decks = autoDecks(state.deckA, state.deckB, state.played);
    if (!decks) return;
    const idleTrack = decks.idle.deck.track;
    if (idleTrack && !decks.used.has(idleTrack.id) && effectiveAnalysis(idleTrack)) return;

    const next = pickNext(decks.current.track, state.tracks, state.queue, decks.used, state.automix.direction);
    if (!next) {
      const status = 'Auto: nothing left to mix in. Add tracks to the queue or library.';
      if (state.automix.status !== status) actions.setAutomixStatus(status);
      return;
    }
    busy.current = true;
    if (state.queue.includes(next.id)) actions.removeFromQueue(next.id);
    actions.loadToDeck(decks.idle.id, next).finally(() => {
      busy.current = false;
    });
  }, [state.automix, state.deckA, state.deckB, state.queue, state.played, state.tracks, actions]);

  // Arm the transition when it is nearly due; until then, count down.
  useEffect(() => {
    const timer = setInterval(() => {
      const { state, actions } = latest.current;
      if (!state.automix.enabled || state.automix.isTransitioning) return;
      const decks = autoDecks(state.deckA, state.deckB, state.played);
      const idleTrack = decks?.idle.deck.track;
      if (!decks || !idleTrack || decks.used.has(idleTrack.id) || armedFor.current === idleTrack.id) return;
      const outgoing = effectiveAnalysis(decks.current.track);
      const incoming = effectiveAnalysis(idleTrack);
      if (!outgoing || !incoming) return;

      const plan = previewTransition(decks.current.id, outgoing, incoming, 'end');
      if (!plan) return;
      const wait = secondsUntilPlan(decks.current.id, outgoing, plan);
      if (wait <= ARM_AHEAD_SECONDS) {
        armedFor.current = idleTrack.id;
        actions.triggerAutomix('end');
        return;
      }
      const status = `Auto: next mix in ${formatWait(wait)} → ${idleTrack.title || idleTrack.fileName} · ${describePlan(plan).replace(/^Mix: /, '')}`;
      if (status !== state.automix.status) actions.setAutomixStatus(status);
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
}

/** The queue's first playable track, else the library track that mixes best from `current`. */
function pickNext(
  current: Track,
  tracks: Track[],
  queue: string[],
  used: Set<string>,
  direction: 'up' | 'down' | 'any',
): Track | null {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  for (const id of queue) {
    const track = byId.get(id);
    if (track && !used.has(id) && effectiveAnalysis(track)) return track;
  }

  const currentAnalysis = effectiveAnalysis(current);
  if (!currentAnalysis) return null;
  const candidates = tracks.filter((t) => !used.has(t.id) && effectiveAnalysis(t));
  if (candidates.length === 0) return null;
  const [best] = suggestNext(
    sequencerTrackFromAnalysis(current.id, currentAnalysis),
    candidates.map((t) => sequencerTrackFromAnalysis(t.id, effectiveAnalysis(t)!)),
    { direction },
    1,
  );
  return best ? byId.get(best.track.id) ?? null : null;
}
