import { describe, expect, it } from 'vitest';
import { fromCamelot, toCamelot } from '../analysis/key';
import type { AudioAnalysis, Phrase } from '../analysis/types';
import { harmonicScore, transpose } from './harmonic';
import {
  orderSet,
  sequencerTrackFromAnalysis,
  suggestNext,
  trackEnergy,
  transitionScore,
  type SequencerTrack,
} from './sequencer';

function track(id: string, bpm: number, camelot: string, energy = 0.6, confidence = 1): SequencerTrack {
  return { id, bpm, key: { ...fromCamelot(camelot)!, confidence }, energy };
}

/** Deterministic PRNG (mulberry32), so shuffles and random sets are the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const next = random(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Tempo steps between neighbours, as ratios minus one (+0.02 = 2% faster). */
function steps(tracks: readonly SequencerTrack[]): number[] {
  return tracks.slice(1).map((t, i) => t.bpm / tracks[i].bpm - 1);
}

function harmonicNeighbours(tracks: readonly SequencerTrack[]): number[] {
  return tracks.slice(1).map((t, i) => harmonicScore(tracks[i].key, t.key));
}

function randomSet(count: number, seed: number): SequencerTrack[] {
  const next = random(seed);
  return Array.from({ length: count }, (_, i) => {
    const camelot = `${1 + Math.floor(next() * 12)}${next() < 0.5 ? 'A' : 'B'}`;
    return track(`t${String(i).padStart(2, '0')}`, 100 + next() * 28, camelot, 0.3 + next() * 0.6);
  });
}

/**
 * 16 tracks climbing 100 → 128 BPM in 1.7% steps; each key mixes with the next (same key, ±1,
 * relative, +2 and +7 moves), energy builds slowly.
 */
const CLIMB_KEYS = ['8A', '9A', '9B', '10B', '10B', '12B', '12A', '1A', '8A', '8B', '7B', '7A', '6A', '8A', '9A', '9B'];
const CLIMB: SequencerTrack[] = CLIMB_KEYS.map((camelot, i) =>
  track(`climb-${String.fromCharCode(97 + i)}`, 100 * Math.pow(1.28, i / 15), camelot, 0.4 + 0.03 * i),
);

describe('trackEnergy', () => {
  const phrase = (bars: number, hasKick: boolean, hasBass: boolean): Phrase => ({
    startBar: 0,
    bars,
    label: 'drop',
    hasKick,
    hasBass,
    energyDb: -10,
  });

  it('is the share of bars that groove, kick-only bars counting half', () => {
    expect(trackEnergy([phrase(16, true, false), phrase(32, true, true), phrase(16, false, false)])).toBeCloseTo(
      (8 + 32) / 64,
      12,
    );
    expect(trackEnergy([phrase(64, true, true)])).toBe(1);
    expect(trackEnergy([])).toBe(0.5);
  });

  it('builds a sequencer track from an analysis', () => {
    const analysis = {
      bpm: 124,
      key: { tonic: 9, mode: 'minor', camelot: '8A', confidence: 0.4, source: 'audio' },
      phrases: [phrase(8, false, false), phrase(24, true, true)],
    } as AudioAnalysis;
    expect(sequencerTrackFromAnalysis('x', analysis)).toEqual({
      id: 'x',
      bpm: 124,
      key: { tonic: 9, mode: 'minor', confidence: 0.4 },
      energy: 0.75,
    });
  });
});

describe('transitionScore', () => {
  it('prefers a close, compatible, gently rising next track', () => {
    const from = track('a', 120, '8A', 0.6);
    const good = transitionScore(from, track('b', 122, '9A', 0.65));
    expect(good.canBlend).toBe(true);
    expect(good.harmonic).toBe(0.9);
    expect(good.direction).toBe(1);
    expect(good.score).toBeGreaterThan(transitionScore(from, track('c', 122, '2B', 0.65), { allowKeyShift: false }).score);
    expect(good.score).toBeGreaterThan(transitionScore(from, track('d', 117, '9A', 0.65)).score);
    expect(good.score).toBeGreaterThan(transitionScore(from, track('e', 122, '9A', 0.2)).score);
  });

  it('penalises a tempo gap too wide to beatmatch', () => {
    const jump = transitionScore(track('a', 100, '8A'), track('b', 128, '8A'));
    expect(jump.canBlend).toBe(false);
    expect(jump.score).toBeLessThan(-2);
  });

  it('scores bigger stretches lower', () => {
    const from = track('a', 110, '8A');
    const tempos = [110, 111, 113, 116, 120, 125].map((bpm) => transitionScore(from, track('b', bpm, '8A')).tempo);
    for (let i = 1; i < tempos.length; i++) expect(tempos[i]).toBeLessThan(tempos[i - 1]);
  });

  it('follows the chosen tempo direction', () => {
    const from = track('a', 120, '8A');
    const up = track('b', 124, '8A');
    const down = track('c', 116, '8A');
    expect(transitionScore(from, up, { direction: 'up' }).direction).toBe(1);
    expect(transitionScore(from, down, { direction: 'up' }).direction).toBeLessThan(0);
    expect(transitionScore(from, down, { direction: 'down' }).direction).toBe(1);
    expect(transitionScore(from, up, { direction: 'down' }).direction).toBeLessThan(0);
    expect(transitionScore(from, down, { direction: 'any' }).direction).toBe(1);
    // Past 8% even a step the right way stops being gradual.
    expect(transitionScore(from, track('d', 135, '8A'), { direction: 'up' }).direction).toBeLessThan(0.5);
  });

  it('shifts a clashing key a semitone only when allowed and both keys are confident', () => {
    const from = track('a', 124, '8A');
    const clash = track('b', 125, '2A');
    const shifted = transitionScore(from, clash, { allowKeyShift: true });
    expect(shifted.keyShift).toBe(-1); // 2A down a semitone is 7A, next to 8A
    expect(shifted.harmonic).toBeCloseTo(0.8, 12); // 0.9 less the cost of shifting

    expect(transitionScore(from, clash, { allowKeyShift: false })).toMatchObject({ keyShift: 0, harmonic: 0 });
    const unsure = track('c', 125, '2A', 0.6, 0.3);
    expect(transitionScore(from, unsure, { allowKeyShift: true })).toMatchObject({ keyShift: 0, harmonic: 0 });
    const untagged: SequencerTrack = { ...clash, key: fromCamelot('2A')! };
    expect(transitionScore(from, untagged, { allowKeyShift: true }).keyShift).toBe(0);
    // Compatible keys stay as they are.
    expect(transitionScore(from, track('d', 125, '9A'), { allowKeyShift: true }).keyShift).toBe(0);
  });

  it('matches against the key the outgoing track was shifted to', () => {
    // 2A played a semitone down is 7A, which 6A sits next to.
    const score = transitionScore(track('a', 124, '2A'), track('b', 125, '6A'), { allowKeyShift: false }, -1);
    expect(score.harmonic).toBe(0.9);
  });
});

describe('orderSet', () => {
  it('turns a shuffled 100 → 128 BPM set into a gradual climb with compatible neighbours', () => {
    const result = orderSet(shuffle(CLIMB, 7), { direction: 'up' });
    const bpms = result.tracks.map((t) => t.bpm);
    expect(bpms[0]).toBeCloseTo(100, 6);
    expect(bpms[bpms.length - 1]).toBeCloseTo(128, 6);
    for (const step of steps(result.tracks)) {
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(0.08);
    }
    expect(result.transitions.every((t) => t.canBlend && t.harmonic >= 0.5)).toBe(true);
    expect(result.tracks.map((t) => t.id)).toEqual(CLIMB.map((t) => t.id));
  });

  it('keeps a random 100 → 128 BPM set climbing and mixes keys better than sorting by tempo', () => {
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    for (const seed of [1, 2, 3]) {
      const set = randomSet(24, seed);
      const result = orderSet(set, { direction: 'up', allowKeyShift: false });
      const byTempo = [...set].sort((a, b) => a.bpm - b.bpm);
      const bpms = result.tracks.map((t) => t.bpm);

      expect(new Set(result.tracks.map((t) => t.id)).size).toBe(set.length);
      expect(bpms[0]).toBeLessThanOrEqual(byTempo[2].bpm);
      expect(bpms[bpms.length - 1]).toBeGreaterThanOrEqual(byTempo[set.length - 3].bpm);
      // Small dips may buy a key match, but the set never slides back from where it got to.
      let peak = bpms[0];
      for (const bpm of bpms) {
        peak = Math.max(peak, bpm);
        expect(bpm / peak).toBeGreaterThan(0.95);
      }
      for (const step of steps(result.tracks)) expect(step).toBeLessThan(0.08);
      expect(mean(harmonicNeighbours(result.tracks))).toBeGreaterThan(mean(harmonicNeighbours(byTempo)) + 0.15);
    }
  });

  it('avoids a tempo jump that cannot blend when a route around it exists', () => {
    // Same key on both ends, but 100 → 128 can't be beatmatched; 114 bridges it despite the clash.
    const set = [track('a', 100, '8A'), track('b', 128, '8A'), track('c', 114, '2B')];
    for (const direction of ['up', 'down', 'any'] as const) {
      const result = orderSet(set, { direction, allowKeyShift: false });
      expect(result.tracks[1].id).toBe('c');
      expect(result.transitions.every((t) => t.canBlend)).toBe(true);
    }
  });

  it('reverses the climb when the set goes down', () => {
    const result = orderSet(shuffle(CLIMB, 11), { direction: 'down' });
    expect(result.tracks.map((t) => t.id)).toEqual(CLIMB.map((t) => t.id).reverse());
    for (const step of steps(result.tracks)) expect(step).toBeLessThan(0);
  });

  it('opens with the requested track', () => {
    const result = orderSet(shuffle(CLIMB, 3), { startId: 'climb-e' });
    expect(result.tracks[0].id).toBe('climb-e');
    expect(result.tracks).toHaveLength(CLIMB.length);
    expect(() => orderSet(CLIMB, { startId: 'missing' })).toThrow();
  });

  it('carries a key shift into the next transition', () => {
    // 2A shifts down to 7A to meet 8A; 6A then mixes with the shifted 7A, not with 2A.
    const set = [track('a', 120, '8A'), track('b', 122, '2A'), track('c', 124, '6A')];
    const shifted = orderSet(set, { allowKeyShift: true });
    expect(shifted.tracks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(shifted.transitions.map((t) => t.keyShift)).toEqual([-1, 0]);
    expect(shifted.transitions[1].harmonic).toBe(0.9);

    const plain = orderSet(set, { allowKeyShift: false });
    expect(plain.transitions.map((t) => t.keyShift)).toEqual([0, 0]);
    expect(plain.score).toBeLessThan(shifted.score);
  });

  it('handles tiny sets', () => {
    expect(orderSet([])).toEqual({ tracks: [], transitions: [], score: 0 });
    const single = orderSet([track('a', 120, '8A')]);
    expect(single.tracks.map((t) => t.id)).toEqual(['a']);
    expect(single.transitions).toEqual([]);
    expect(orderSet([track('b', 124, '8A'), track('a', 120, '8A')]).tracks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('is deterministic, whatever order the tracks arrive in', () => {
    const set = randomSet(30, 42);
    const first = orderSet(set).tracks.map((t) => t.id);
    expect(orderSet(set).tracks.map((t) => t.id)).toEqual(first);
    expect(orderSet(shuffle(set, 5)).tracks.map((t) => t.id)).toEqual(first);
  });

  it('orders 40 tracks in under 100 ms', () => {
    const set = randomSet(40, 9);
    const started = performance.now();
    const result = orderSet(set);
    const elapsed = performance.now() - started;
    expect(result.tracks).toHaveLength(40);
    expect(elapsed).toBeLessThan(100);
  });
});

describe('suggestNext', () => {
  it('ranks a compatible track at a close tempo first', () => {
    const current = track('now', 120, '8A', 0.6);
    const candidates = [
      track('far', 127, '8A', 0.65),
      track('clash', 121, '2B', 0.65),
      track('match', 121.5, '9A', 0.65),
      track('slower', 112, '8A', 0.65),
      track('unblendable', 150, '8A', 0.65),
      current,
    ];
    const ranked = suggestNext(current, candidates, { allowKeyShift: false }, 10);
    expect(ranked.map((s) => s.track.id)).not.toContain('now');
    expect(ranked).toHaveLength(5);
    expect(ranked[0].track.id).toBe('match');
    expect(ranked[ranked.length - 1].track.id).toBe('unblendable');
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].transition.score).toBeLessThanOrEqual(ranked[i - 1].transition.score);
    }
    expect(suggestNext(current, candidates, {}, 2)).toHaveLength(2);
  });

  it('reports the key shift that makes a candidate fit', () => {
    const [best] = suggestNext(track('now', 120, '8A'), [track('x', 121, '3A')], { allowKeyShift: true }, 1);
    expect(best.transition.keyShift).toBe(-1);
    expect(toCamelot(transpose(best.track.key, best.transition.keyShift))).toBe('8A');
  });
});
