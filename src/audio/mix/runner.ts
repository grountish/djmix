import type { BeatClock } from '../analysis/beatClock';
import { filterKnobToCutoffs } from '../engine/curves';
import type { DeckPlayer } from '../engine/deckPlayer';
import { type DeckId, type MixGraph, setCrossfaderPosition, setParamSmooth } from '../engine/mixGraph';
import { STRETCH_LEAD } from '../engine/stretch';
import type { TransitionPlan } from './planner';
import { eqDbToGain, interpolate, type Lane, type LaneControl, type LaneTarget, laneValueAt } from './templates';

export interface RunnerDeck {
  id: DeckId;
  player: DeckPlayer;
  clock: BeatClock;
}

interface Command {
  at: number;
  /** 'started' / 'stop' fire once the clock passes `at`; 'rate' goes out ahead of it. */
  kind: 'rate' | 'stop' | 'started';
  rate?: number;
}

/** Where every automated control stands, per deck, in the lanes' own units. */
export type LaneValues = Record<LaneTarget, Partial<Record<LaneControl, number>>>;

/** Rate changes go out this far ahead: past the stretcher's lead, one pending per deck. */
const SEND_AHEAD = STRETCH_LEAD + 0.15;
const CURVE_POINTS = 48;
const RATE_EPSILON = 1e-7;
/**
 * Beat-lock rates further than this from the planned incoming rate mean a beat clock is wrong
 * (beats miscounted); the incoming deck then holds the planned rate instead of chasing them.
 */
const MAX_LOCK_DEVIATION = 0.03;

/**
 * Plays a TransitionPlan on the audio clock. Everything is derived from the outgoing track's
 * beat timeline, so the incoming deck is locked beat for beat: each beat it gets the rate
 * that brings its next beat onto the outgoing deck's next beat. Call `start()` once, then
 * `dispatch(now)` regularly (at `nextWakeTime()`) until `finished`.
 */
export class TransitionRunner {
  /** Clock time the incoming track enters (overlap start). */
  incomingStart = 0;
  /** Clock time the outgoing track is gone (overlap end). */
  overlapEnd = 0;
  /** Clock time the incoming track is back at its own tempo. */
  finishTime = 0;
  finished = false;
  /** The beat clocks disagreed beyond MAX_LOCK_DEVIATION, so the incoming deck wasn't beat-locked. */
  lockAbandoned = false;

  private readonly queues: Record<LaneTarget, Command[]> = { outgoing: [], incoming: [] };
  private readonly pendingUntil: Record<LaneTarget, number> = { outgoing: -Infinity, incoming: -Infinity };
  private readonly outgoingBeats = new Map<number, number>();
  private automated: AudioParam[] = [];
  private startBeat = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly graph: MixGraph,
    private readonly outgoing: RunnerDeck,
    private readonly incoming: RunnerDeck,
    private readonly plan: TransitionPlan,
    private readonly events: {
      onIncomingStarted?: () => void;
      onOutgoingStopped?: () => void;
      onFinished?: () => void;
    } = {},
  ) {}

  start(): void {
    const out = this.outgoing.player;
    if (!out.isPlaying) throw new Error('The outgoing deck must be playing');
    out.setKeyLock(true);
    const anchor = out.getAnchor()!;
    this.pendingUntil.outgoing = anchor.ctxTime;

    const startBeat = this.plan.outgoingStartBar * 4;
    const endBeat = startBeat + this.plan.overlapBars * 4;
    this.buildOutgoingTimeline(anchor, startBeat, endBeat);
    this.incomingStart = this.outgoingBeats.get(startBeat)!;
    this.overlapEnd = this.outgoingBeats.get(endBeat)!;

    this.startIncoming(startBeat, endBeat);
    this.queues.incoming.unshift({ at: this.incomingStart, kind: 'started' });
    this.queues.outgoing.push({ at: this.overlapEnd, kind: 'stop' });
    this.startBeat = startBeat;

    setCrossfaderPosition(this.graph, 0);
    for (const lane of this.plan.lanes) this.scheduleLane(lane, startBeat);
  }

  /** Whether the incoming deck is audible yet. */
  incomingStarted(now: number): boolean {
    return now >= this.incomingStart;
  }

  /** Every lane's value at `now`, for showing the automation on the controls. */
  laneValues(now: number): LaneValues {
    const values: LaneValues = { outgoing: {}, incoming: {} };
    const bar = this.barAt(now);
    for (const lane of this.plan.lanes) values[lane.target][lane.control] = laneValueAt(lane, bar);
    return values;
  }

  /** Clock time of an outgoing beat (beat 0 = its first downbeat), once started. */
  outgoingBeatTime(beat: number): number | undefined {
    return this.outgoingBeats.get(beat);
  }

  /** When `dispatch` next has work to do; null once finished. */
  nextWakeTime(): number | null {
    if (this.finished) return null;
    const times = (Object.keys(this.queues) as LaneTarget[]).flatMap((deck) => {
      const head = this.queues[deck][0];
      if (!head) return [];
      return [head.kind === 'rate' ? Math.max(head.at - SEND_AHEAD, this.pendingUntil[deck]) : head.at];
    });
    return Math.min(...times, this.finishTime);
  }

  dispatch(now: number): void {
    if (this.finished) return;
    for (const deck of Object.keys(this.queues) as LaneTarget[]) {
      const queue = this.queues[deck];
      while (queue.length > 0) {
        const command = queue[0];
        if (command.kind === 'stop' || command.kind === 'started') {
          if (now < command.at) break;
          if (command.kind === 'stop') this.stopOutgoing();
          else this.events.onIncomingStarted?.();
        } else {
          if (command.at - now > SEND_AHEAD || now < this.pendingUntil[deck]) break;
          this.deckFor(deck).player.scheduleRate(command.at, command.rate!);
          this.pendingUntil[deck] = command.at;
        }
        queue.shift();
      }
    }
    if (now >= this.finishTime && this.queues.outgoing.length === 0 && this.queues.incoming.length === 0) {
      this.finished = true;
      this.events.onFinished?.();
    }
  }

  /** Stops the automation where it is; both decks keep playing. */
  cancel(): void {
    const now = this.ctx.currentTime;
    for (const param of this.automated) param.cancelAndHoldAtTime(now);
    this.queues.outgoing = [];
    this.queues.incoming = [];
    this.finished = true;
  }

  private deckFor(target: LaneTarget): RunnerDeck {
    return target === 'outgoing' ? this.outgoing : this.incoming;
  }

  /** Clock time of every outgoing beat up to the overlap end, with its tempo ramp. */
  private buildOutgoingTimeline(
    anchor: { ctxTime: number; trackTime: number; rate: number },
    startBeat: number,
    endBeat: number,
  ): void {
    const clock = this.outgoing.clock;
    const rampStart = this.plan.outgoingRampStartBar * 4;
    const from = anchor.rate;
    const to = this.plan.tempo.outgoingRate;
    const rateFor = (beat: number) => {
      if (beat < rampStart) return from;
      if (beat >= startBeat || startBeat === rampStart) return to;
      return from * Math.pow(to / from, (beat - rampStart + 1) / (startBeat - rampStart));
    };

    let beat = Math.floor(clock.beatAt(anchor.trackTime)) + 1;
    let time = anchor.ctxTime + (clock.timeOf(beat) - anchor.trackTime) / from;
    let rate = from;
    for (; beat <= endBeat + 1; beat++) {
      this.outgoingBeats.set(beat, time);
      const next = rateFor(beat);
      if (beat <= endBeat && Math.abs(next - rate) > RATE_EPSILON) {
        this.queues.outgoing.push({ at: time, kind: 'rate', rate: next });
        rate = next;
      }
      time += (clock.timeOf(beat + 1) - clock.timeOf(beat)) / rate;
    }
  }

  /** Cues the incoming deck, locks it beat for beat, then eases it back to its own tempo. */
  private startIncoming(startBeat: number, endBeat: number): void {
    const { player, clock } = this.incoming;
    const firstBeat = this.plan.incomingStartBar * 4;
    const overlapBeats = endBeat - startBeat;
    const planned = this.plan.tempo.incomingRate;
    const lockRate = (j: number) =>
      (clock.timeOf(firstBeat + j + 1) - clock.timeOf(firstBeat + j)) /
      (this.outgoingBeats.get(startBeat + j + 1)! - this.outgoingBeats.get(startBeat + j)!);
    this.lockAbandoned = Array.from({ length: overlapBeats }, (_, j) => lockRate(j)).some(
      (rate) => Math.abs(rate / planned - 1) > MAX_LOCK_DEVIATION,
    );
    const beatRate = (j: number) => (this.lockAbandoned ? planned : lockRate(j));

    let rate = overlapBeats > 0 ? beatRate(0) : planned;
    player.pause();
    player.setKeyLock(true);
    player.setSemitones(this.plan.incomingSemitones);
    player.setRate(rate);
    player.seek(clock.timeOf(firstBeat));
    player.play(this.incomingStart);
    this.pendingUntil.incoming = this.incomingStart;

    for (let j = 1; j < overlapBeats; j++) {
      const next = beatRate(j);
      if (Math.abs(next - rate) > RATE_EPSILON) {
        this.queues.incoming.push({ at: this.outgoingBeats.get(startBeat + j)!, kind: 'rate', rate: next });
        rate = next;
      }
    }

    // After the overlap the incoming track leads; ease it back to its own tempo.
    const rampBeats = this.plan.tempo.incomingRampBars * 4;
    let beat = firstBeat + overlapBeats;
    let time = this.overlapEnd;
    const from = rate;
    for (let n = 0; n < rampBeats; n++, beat++) {
      rate = from * Math.pow(1 / from, (n + 1) / rampBeats);
      this.queues.incoming.push({ at: time, kind: 'rate', rate });
      time += (clock.timeOf(beat + 1) - clock.timeOf(beat)) / rate;
    }
    this.finishTime = time;
  }

  private stopOutgoing(): void {
    const id = this.outgoing.id;
    this.outgoing.player.pause();
    const deck = this.graph.decks[id];
    for (const param of [deck.fader.gain, deck.eq.low.gain, deck.eq.mid.gain, deck.eq.high.gain]) {
      setParamSmooth(param, 1, this.ctx);
    }
    setParamSmooth(deck.filter.lowpass.frequency, this.ctx.sampleRate / 2, this.ctx);
    setParamSmooth(deck.filter.highpass.frequency, 0, this.ctx);
    this.events.onOutgoingStopped?.();
  }

  /** Overlap-relative bar at clock time `time` (inverse of barTime). */
  private barAt(time: number): number {
    const beats = [...this.outgoingBeats.keys()];
    let lo = 0;
    let hi = beats.length - 1;
    if (time <= this.outgoingBeats.get(beats[0])!) return (beats[0] - this.startBeat) / 4;
    if (time >= this.outgoingBeats.get(beats[hi])!) return (beats[hi] - this.startBeat) / 4;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.outgoingBeats.get(beats[mid])! <= time) lo = mid;
      else hi = mid;
    }
    const a = this.outgoingBeats.get(beats[lo])!;
    const b = this.outgoingBeats.get(beats[hi])!;
    return (beats[lo] + (time - a) / (b - a) - this.startBeat) / 4;
  }

  /** Clock time of an overlap-relative bar, interpolated within the outgoing beat timeline. */
  private barTime(bar: number, startBeat: number): number {
    const beat = startBeat + bar * 4;
    const below = Math.floor(beat);
    const a = this.outgoingBeats.get(below);
    const b = this.outgoingBeats.get(below + 1);
    if (a === undefined || b === undefined) {
      const known = [...this.outgoingBeats.keys()];
      return this.outgoingBeats.get(beat < known[0] ? known[0] : known[known.length - 1])!;
    }
    return a + (b - a) * (beat - below);
  }

  private scheduleLane(lane: Lane, startBeat: number): void {
    const deck = this.graph.decks[this.deckFor(lane.target).id];
    const targets: { param: AudioParam; value: (v: number) => number }[] =
      lane.control === 'fader'
        ? [{ param: deck.fader.gain, value: (v) => v }]
        : lane.control === 'filter'
          ? [
              { param: deck.filter.highpass.frequency, value: (v) => filterKnobToCutoffs(v, this.ctx.sampleRate / 2).highpassHz },
              { param: deck.filter.lowpass.frequency, value: (v) => filterKnobToCutoffs(v, this.ctx.sampleRate / 2).lowpassHz },
            ]
          : [{ param: deck.eq[lane.control].gain, value: eqDbToGain }];

    const now = this.ctx.currentTime;
    for (const { param, value } of targets) {
      this.automated.push(param);
      param.cancelAndHoldAtTime(now);
      // The incoming deck is silent until it starts, so its lanes take their opening value now.
      if (lane.target === 'incoming') param.setValueAtTime(value(lane.points[0].value), now);

      for (let i = 1; i < lane.points.length; i++) {
        const from = lane.points[i - 1];
        const to = lane.points[i];
        const t0 = Math.max(this.barTime(from.bar, startBeat), now);
        const t1 = this.barTime(to.bar, startBeat);
        if (t1 <= t0) {
          param.setValueAtTime(value(to.value), t0);
          continue;
        }
        const curve = new Float32Array(CURVE_POINTS);
        for (let s = 0; s < CURVE_POINTS; s++) {
          curve[s] = value(interpolate(lane, from.value, to.value, s / (CURVE_POINTS - 1)));
        }
        param.setValueCurveAtTime(curve, t0, t1 - t0);
      }
    }
  }
}

/** Dispatch interval for offline renders; well inside the send-ahead window. */
const OFFLINE_TICK = 0.05;

/**
 * Drives a runner inside an OfflineAudioContext render: suspends on a fixed tick (every
 * suspend is registered up front; some implementations refuse new ones while suspended), lets
 * the runner send its commands and waits until the stretchers have them before rendering on.
 */
export async function renderWithRunner(
  ctx: OfflineAudioContext,
  runner: TransitionRunner,
  players: DeckPlayer[],
): Promise<AudioBuffer> {
  const quantum = 128 / ctx.sampleRate;
  const end = ctx.length / ctx.sampleRate;
  const tick = Math.ceil(OFFLINE_TICK / quantum) * quantum;
  for (let at = Math.ceil((ctx.currentTime + quantum) / tick) * tick; at < end; at += tick) {
    ctx.suspend(at).then(async () => {
      runner.dispatch(ctx.currentTime);
      await Promise.all(players.map((player) => player.settled()));
      await ctx.resume();
    });
  }
  await Promise.all(players.map((player) => player.settled()));
  return ctx.startRendering();
}
