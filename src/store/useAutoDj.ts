import { useEffect, useRef } from 'react';
import { effectiveAnalysis } from '@/audio/analysis/overrides';
import {
  describePlan,
  formatCountdown,
  previewTransition,
  secondsUntilOverlap,
  secondsUntilPlan,
} from '@/audio/automixController';
import { sequencerTrackFromAnalysis, suggestNext } from '@/audio/mix/sequencer';
import { trackClock } from '@/audio/mix/trackClock';
import type { DeckState, Track } from '@/types';
import { type NextMix, useApp } from './AppContext';

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
  const wasEnabled = useRef(false);

  // Start the set and keep the next track cued.
  useEffect(() => {
    const justEnabled = state.automix.enabled && !wasEnabled.current;
    wasEnabled.current = state.automix.enabled;
    if (!state.automix.enabled || state.automix.isTransitioning || busy.current) return;
    const played = new Set(state.played);
    const bothIdle = !state.deckA.playback.isPlaying && !state.deckB.playback.isPlaying;
    if (bothIdle) {
      // Only when Auto has just been switched on: a deck the user stops stays stopped.
      if (!justEnabled) return;
      const ready = (['A', 'B'] as const).find((id) => {
        const track = (id === 'A' ? state.deckA : state.deckB).track;
        return track && !played.has(track.id) && track.analysis;
      });
      if (ready) actions.startDeck(ready);
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

  // Preview the next mix (Auto's, at the end of the track; otherwise what Mix now would do) for
  // the inspector, and with Auto on arm it when it is nearly due; until then, count down.
  useEffect(() => {
    const timer = setInterval(() => {
      const { state, actions } = latest.current;
      const { automix } = state;
      if (automix.isTransitioning) return;
      const clearNext = () => {
        if (automix.next && !automix.next.live) actions.setAutomixNext(null);
      };
      const decks = autoDecks(state.deckA, state.deckB, state.played);
      const idleTrack = decks?.idle.deck.track;
      if (!decks || !idleTrack || (automix.enabled && decks.used.has(idleTrack.id))) return clearNext();
      const outgoing = effectiveAnalysis(decks.current.track);
      const incoming = effectiveAnalysis(idleTrack);
      if (!outgoing || !incoming) return clearNext();

      const timing = automix.enabled ? 'end' : 'now';
      const chosen = automix.startBar;
      const startBar = chosen && chosen.trackId === decks.current.track.id ? chosen.bar : undefined;
      const plan = previewTransition(decks.current.id, outgoing, incoming, timing, startBar, automix.style);
      if (!plan) return clearNext();

      const next: NextMix = {
        outgoing: decks.current.id,
        incoming: decks.idle.id,
        outgoingTrackId: decks.current.track.id,
        incomingTrackId: idleTrack.id,
        timing,
        live: false,
        plan,
      };
      if (!automix.next?.live && !samePlan(automix.next, next)) actions.setAutomixNext(next);

      if (!automix.enabled || armedFor.current === idleTrack.id) return;
      // Park the next track on its cue point, so the deck shows where it will come in.
      const cueTime = trackClock(incoming).timeOf(plan.incomingStartBar * 4);
      const cued = decks.idle.deck.cuePoint;
      if (cued === null || Math.abs(cued - cueTime) > 0.01) actions.cueDeckAt(decks.idle.id, cueTime);
      const wait = secondsUntilPlan(decks.current.id, outgoing, plan);
      if (wait <= ARM_AHEAD_SECONDS) {
        armedFor.current = idleTrack.id;
        actions.triggerAutomix('end');
        return;
      }
      const untilHeard = secondsUntilOverlap(decks.current.id, outgoing, plan);
      const status = `Mixing in ${formatCountdown(untilHeard)} → ${idleTrack.title || idleTrack.fileName} · ${describePlan(plan)}`;
      if (status !== automix.status) actions.setAutomixStatus(status);
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
}

/** Whether two previews would draw and read the same (the plan's timing moves with the deck). */
function samePlan(a: NextMix | null, b: NextMix): boolean {
  if (!a) return false;
  const key = (n: NextMix) =>
    [
      n.outgoing,
      n.outgoingTrackId,
      n.incomingTrackId,
      n.timing,
      n.plan.kind,
      n.plan.overlapBars,
      n.plan.outgoingStartBar,
      n.plan.incomingStartBar,
      n.plan.bassSwapBar,
      n.plan.outgoingLoop?.startBar ?? -1,
      n.plan.outgoingLoop?.bars ?? 0,
      n.plan.incomingLoop ? `${n.plan.incomingLoop.startBar}/${n.plan.incomingLoop.bars}/${n.plan.incomingLoop.repeats}` : '-',
      n.plan.warnings.join('|'),
    ].join(',');
  return key(a) === key(b);
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
