import type { BeatClock } from '../analysis/beatClock';
import type { DeckPlayer } from './deckPlayer';
import { STRETCH_LEAD } from './stretch';
import { ctxTimeAt, SCHEDULE_LEAD, trackTimeAt } from './transport';

/** A loop region in track seconds; the playhead jumps back to `start` on reaching `end`. */
export interface LoopRegion {
  start: number;
  end: number;
}

/** Auto-loop lengths, in beats: 1/8 bar … 32 bars. */
export const LOOP_SIZES_BEATS = [0.5, 1, 2, 4, 8, 16, 32, 64, 128];

/** Shortest loop, in beats, that the wrap scheduling can keep up with. */
export const MIN_LOOP_BEATS = 0.5;

/** Beat length assumed for a track without a grid. */
const FALLBACK_BEAT_SECONDS = 0.5;

/** A wrap is scheduled once it comes within this many seconds. */
const WRAP_HORIZON = 0.25;
/** How often the live timer looks for the next wrap. */
const TICK_MS = 25;

/**
 * Loops a deck on its beat grid. Each wrap is a `DeckPlayer.scheduleJump` placed exactly on
 * the audio clock, armed by `tick()` shortly before it falls due (a live timer while the loop
 * is active; tests tick by hand). The loop is a region: leaving it (a seek, a cue) stops it
 * wrapping and coming back in starts it again, like a CDJ.
 */
export class LoopController {
  private region: LoopRegion | null = null;
  private active = false;
  private clock: BeatClock | null = null;
  private pendingIn: number | null = null;
  /** Clock time of a wrap already handed to the player, until it has passed. */
  private scheduledWrapAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Fires after any change to the region or the active state. */
  onChange?: () => void;

  constructor(
    private readonly player: DeckPlayer,
    private readonly ctx: BaseAudioContext,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get currentRegion(): LoopRegion | null {
    return this.region ? { ...this.region } : null;
  }

  /** The loop's length in beats on the current grid, or null without a loop. */
  get lengthBeats(): number | null {
    if (!this.region) return null;
    if (!this.clock) return (this.region.end - this.region.start) / FALLBACK_BEAT_SECONDS;
    return this.clock.beatAt(this.region.end) - this.clock.beatAt(this.region.start);
  }

  /** A new track: its grid (null when unknown), and no loop. */
  setClock(clock: BeatClock | null): void {
    this.clock = clock;
    this.clear();
  }

  clear(): void {
    this.cancelScheduledWrap();
    this.region = null;
    this.pendingIn = null;
    this.setActive(false);
  }

  /**
   * Loops `beats` beats from the beat nearest `from` (the playhead by default) and starts
   * looping. The first wrap is scheduled on the next tick.
   */
  autoLoop(beats: number, from: number = this.player.currentTime()): LoopRegion {
    const length = Math.max(beats, MIN_LOOP_BEATS);
    let start = from;
    let end = from + length * FALLBACK_BEAT_SECONDS;
    if (this.clock) {
      const startBeat = Math.round(this.clock.beatAt(from));
      start = this.clock.timeOf(startBeat);
      end = this.clock.timeOf(startBeat + length);
    }
    this.setRegion({ start, end });
    this.setActive(true);
    return this.currentRegion!;
  }

  /** Marks the loop start (on the nearest beat when `quantize`); `loopOut` closes it. */
  loopIn(time: number = this.player.currentTime(), quantize = true): number {
    this.pendingIn = this.quantized(time, quantize);
    this.onChange?.();
    return this.pendingIn;
  }

  /**
   * Closes a loop at `time` (nearest beat when `quantize`) from the pending loop-in, or from
   * the existing loop's start, and starts looping. Ignored when that gives an empty loop.
   */
  loopOut(time: number = this.player.currentTime(), quantize = true): LoopRegion | null {
    const start = this.pendingIn ?? this.region?.start;
    if (start === undefined) return null;
    const end = this.quantized(time, quantize);
    if (end <= start) return null;
    this.pendingIn = null;
    this.setRegion({ start, end });
    this.setActive(true);
    return this.currentRegion;
  }

  /** Halves the loop; a playhead past the new end jumps back in step at once. */
  halve(): void {
    this.resize(0.5);
  }

  /** Doubles the loop (within the track). */
  double(): void {
    this.resize(2);
  }

  /** Stops looping, keeping the region for `reloop`. */
  exit(): void {
    if (!this.active) return;
    this.cancelScheduledWrap();
    this.setActive(false);
  }

  /** Starts looping the kept region again; a playhead outside it jumps to the start. */
  reloop(): void {
    if (!this.region) return;
    this.setActive(true);
    if (this.player.isPlaying) {
      const now = this.ctx.currentTime;
      const position = this.player.currentTime();
      if (position < this.region.start || position >= this.region.end) {
        this.player.scheduleJump(now + this.lead(), this.region.start);
      }
    } else {
      const position = this.player.currentTime();
      if (position < this.region.start || position >= this.region.end) this.player.seek(this.region.start);
    }
  }

  /**
   * Arms the next wrap once it comes within the horizon. `now` is the clock time to reason
   * from (the context's by default).
   */
  tick(now: number = this.ctx.currentTime): void {
    if (!this.active || !this.region || !this.player.isPlaying) return;
    if (this.scheduledWrapAt !== null) {
      if (now < this.scheduledWrapAt) return;
      this.scheduledWrapAt = null;
    }
    const anchor = this.player.getAnchor();
    if (!anchor || anchor.rate <= 0) return;
    const position = trackTimeAt(anchor, now);
    if (position < this.region.start || position >= this.region.end) return;

    const wrapAt = ctxTimeAt(anchor, this.region.end);
    if (wrapAt - now > WRAP_HORIZON) return;
    // Late (a seek just before the end): wrap as soon as possible, staying in step.
    const at = Math.max(wrapAt, now + this.lead());
    const target = this.region.start + (at - wrapAt) * anchor.rate;
    this.scheduledWrapAt = this.player.scheduleJump(at, target);
  }

  private resize(factor: number): void {
    if (!this.region) return;
    const { start } = this.region;
    const beats = this.lengthBeats!;
    const newBeats = Math.max(beats * factor, MIN_LOOP_BEATS);
    let end = this.clock
      ? this.clock.timeOf(this.clock.beatAt(start) + newBeats)
      : start + newBeats * FALLBACK_BEAT_SECONDS;
    end = Math.min(end, this.player.duration || end);
    if (end <= start) return;
    this.cancelScheduledWrap();
    this.setRegion({ start, end });

    const anchor = this.player.getAnchor();
    if (this.active && anchor) {
      // Where the playhead will be when the jump lands, so the loop stays in step.
      const at = this.ctx.currentTime + this.lead();
      const position = trackTimeAt(anchor, at);
      if (position >= end) {
        const length = end - start;
        this.player.scheduleJump(at, start + ((position - start) % length));
      }
    }
  }

  private quantized(time: number, quantize: boolean): number {
    if (!quantize || !this.clock) return time;
    return this.clock.timeOf(Math.round(this.clock.beatAt(time)));
  }

  /**
   * A wrap already handed to the player can't be taken back, but it can be redirected to
   * where the playhead would have been anyway: a jump to the loop end at the same instant.
   */
  private cancelScheduledWrap(): void {
    if (this.scheduledWrapAt === null) return;
    const at = this.scheduledWrapAt;
    this.scheduledWrapAt = null;
    if (!this.region || !this.player.isPlaying || at <= this.ctx.currentTime) return;
    this.player.scheduleJump(at, this.region.end);
  }

  private setRegion(region: LoopRegion): void {
    this.region = region;
    this.onChange?.();
  }

  private setActive(active: boolean): void {
    const changed = active !== this.active;
    this.active = active;
    if (active) this.startTimer();
    else this.stopTimer();
    if (changed) this.onChange?.();
  }

  /** Lead the player needs for an exact jump on its current path. */
  private lead(): number {
    return (this.player.isKeyLocked ? STRETCH_LEAD : SCHEDULE_LEAD) + 0.005;
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    // Timers only make sense on a live clock.
    if (typeof AudioContext === 'undefined' || !(this.ctx instanceof AudioContext)) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
