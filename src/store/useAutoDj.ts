import { useEffect, useRef } from 'react';
import { effectiveAnalysis } from '@/audio/analysis/overrides';
import { sequencerTrackFromAnalysis, suggestNext } from '@/audio/mix/sequencer';
import type { Track } from '@/types';
import { useApp } from './AppContext';

type DeckId = 'A' | 'B';

/**
 * Auto DJ. While Auto is on it keeps the set going: starts the loaded deck, keeps the next
 * track (the queue's head, else the library's best match) loaded on the idle deck and arms
 * one planned transition per loaded track. The planner places the mix near the end of the
 * playing track, so arming early is fine.
 */
export function useAutoDj(): void {
  const { state, actions } = useApp();
  const armedFor = useRef<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!state.automix.enabled || state.automix.isTransitioning || busy.current) return;
    const decks = [
      { id: 'A' as DeckId, deck: state.deckA },
      { id: 'B' as DeckId, deck: state.deckB },
    ];
    const playing = decks.filter((d) => d.deck.playback.isPlaying);
    const played = new Set(state.played);

    // Nothing playing yet: start a loaded, unplayed track.
    if (playing.length === 0) {
      const ready = decks.find((d) => d.deck.track && !played.has(d.deck.track.id) && d.deck.track.analysis);
      if (ready) actions.playPauseDeck(ready.id);
      return;
    }
    if (playing.length !== 1) return;

    const current = playing[0];
    const idle = decks.find((d) => d.id !== current.id)!;
    const currentTrack = current.deck.track;
    if (!currentTrack) return;
    const used = new Set([...played, currentTrack.id]);

    const idleTrack = idle.deck.track;
    if (idleTrack && !used.has(idleTrack.id) && effectiveAnalysis(idleTrack)) {
      if (armedFor.current !== idleTrack.id) {
        armedFor.current = idleTrack.id;
        actions.triggerAutomix();
      }
      return;
    }

    const next = pickNext(currentTrack, state.tracks, state.queue, used, state.automix.direction);
    if (!next) return;
    busy.current = true;
    if (state.queue.includes(next.id)) actions.removeFromQueue(next.id);
    actions.loadToDeck(idle.id, next).finally(() => {
      busy.current = false;
    });
  }, [state.automix, state.deckA, state.deckB, state.queue, state.played, state.tracks, actions]);
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
