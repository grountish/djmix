import { clamp } from './curves';
import type { StretchChange } from 'signalsmith-stretch';
import {
  PARKED_INPUT,
  STRETCH_LEAD,
  STRETCH_OUTPUT_DELAY,
  type StretchFactory,
  type StretchNode,
} from './stretch';
import {
  alignToRenderQuantum,
  ctxTimeAt,
  type PlayheadAnchor,
  rebaseAnchor,
  SCHEDULE_LEAD,
  trackTimeAt,
} from './transport';

/** Length of the fade that mutes a stopped stretcher: short enough to feel instant, no click. */
const GATE_FADE = 0.005;

/**
 * Plays an AudioBuffer into a persistent deck channel. The playhead is derived from anchors
 * on the audio clock, so it stays exact across rate changes and scheduled starts.
 *
 * Without key lock the buffer plays through an AudioBufferSourceNode (pitch follows tempo).
 * With key lock it plays through a time-stretcher that keeps pitch, optionally shifted by
 * whole semitones. Both paths follow the same anchors.
 */
export class DeckPlayer {
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private stretch: StretchNode | null = null;
  private stretchRunning = false;
  /** Sits behind the stretcher: an immediate stop mutes it here, since parking it lands late. */
  private gate: GainNode | null = null;
  /** Loads run one after another so two quick loads can't mix their audio. */
  private loading: Promise<void> = Promise.resolve();
  private stretchMessages: Promise<unknown> = Promise.resolve();
  /** Playhead segments in clock order; each takes over at its `ctxTime`. */
  private anchors: PlayheadAnchor[] = [];
  private rate = 1;
  private keyLock = false;
  private semitones = 0;
  private pausedAt = 0;
  private playing = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  onEnded?: () => void;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly output: AudioNode,
    private readonly createStretch?: StretchFactory,
  ) {}

  get audioBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isKeyLocked(): boolean {
    return this.keyLock;
  }

  /** Semitones the deck is pitch-shifted by while key lock is on. */
  get keyShift(): number {
    return this.keyLock ? this.semitones : 0;
  }

  /** Current playback rate (the rate in effect now, not a pending change). */
  get currentRate(): number {
    if (!this.playing) return this.rate;
    return this.anchorAt(this.ctx.currentTime).rate;
  }

  /** Loads a track; with a stretch factory the stretcher gets its own copy of the audio. */
  load(buffer: AudioBuffer): Promise<void> {
    this.loading = this.loading.then(async () => {
      this.stop();
      this.buffer = buffer;
      if (!this.createStretch) return;

      if (!this.stretch) {
        this.stretch = await this.createStretch(this.ctx);
        this.gate = this.ctx.createGain();
        this.stretch.connect(this.gate);
        this.gate.connect(this.output);
      }
      await this.stretch.dropBuffers();
      const channels = [0, 1].map((c) =>
        buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)).slice(),
      );
      await this.stretch.addBuffers(
        channels,
        channels.map((channel) => channel.buffer),
      );
    });
    return this.loading;
  }

  /**
   * Starts at audio-clock time `when`. Without `when` it starts as soon as the audio thread
   * can honour it exactly. Returns false when there is nothing to play.
   */
  play(when?: number): boolean {
    if (!this.buffer || this.playing) return false;
    this.startOutput(when ?? this.nextChangeTime(), this.pausedAt);
    this.playing = true;
    return true;
  }

  /** Stops output and keeps the playhead where it is. */
  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.currentTime();
    this.stopOutput();
    this.playing = false;
  }

  stop(): void {
    this.pause();
    this.pausedAt = 0;
  }

  seek(time: number): void {
    const target = clamp(time, 0, this.duration);
    if (!this.playing) {
      this.pausedAt = target;
      return;
    }
    // Hand over from the old output to the new one at the same instant: no gap.
    const at = this.nextChangeTime();
    this.stopOutput(at);
    this.startOutput(at, target);
  }

  setRate(rate: number): void {
    this.scheduleRate(this.nextChangeTime(), rate);
  }

  /**
   * Changes the rate at audio-clock time `at`, rounded up to a render-quantum edge so the
   * playhead math stays exact; returns the time used. Callers schedule one change at a time,
   * at least the path's lead ahead (the stretcher keeps a single pending change).
   */
  scheduleRate(time: number, rate: number): number {
    const at = alignToRenderQuantum(time, this.ctx.sampleRate);
    this.rate = rate;
    if (!this.playing) return at;

    const now = this.ctx.currentTime;
    while (this.anchors.length > 1 && this.anchors[1].ctxTime <= now) this.anchors.shift();
    const last = this.anchors[this.anchors.length - 1];
    const rebased = rebaseAnchor(last, at, rate);
    if (rebased.ctxTime === last.ctxTime) this.anchors[this.anchors.length - 1] = rebased;
    else this.anchors.push(rebased);

    if (this.keyLock) {
      // While a start is pending this re-issues the start with the new rate.
      this.scheduleStretch({ at: rebased.ctxTime, input: rebased.trackTime, rate });
      this.watchEnd();
    } else if (this.source) {
      // playbackRate is k-rate: it is read at each block edge. An event exactly on the edge
      // can round to just after it and slip a whole block, so place it half a frame early.
      this.source.playbackRate.setValueAtTime(rate, at - 0.5 / this.ctx.sampleRate);
    }
    return at;
  }

  /** Key lock keeps pitch while the tempo changes; needs a stretch factory. */
  setKeyLock(enabled: boolean): void {
    if (enabled === this.keyLock) return;
    if (!this.playing) {
      this.keyLock = enabled;
      return;
    }
    if (enabled && !this.stretch) return;
    const at = this.handoverTime(true);
    const position = trackTimeAt(this.anchorAt(at), at);
    this.stopOutput(at);
    this.keyLock = enabled;
    this.startOutput(at, position);
  }

  /** Pitch shift in semitones while key lock is on (e.g. ±1 for harmonic mixing). */
  setSemitones(semitones: number): void {
    this.semitones = semitones;
    if (!this.playing || !this.keyLock) return;
    const at = Math.max(this.handoverTime(false), this.anchors[0].ctxTime);
    this.scheduleStretch({ at, input: trackTimeAt(this.anchorAt(at), at), rate: this.rate });
  }

  /**
   * Resolves once the stretcher has received every change sent so far. Offline rendering
   * can otherwise run past a change before the worklet sees it.
   */
  async settled(): Promise<void> {
    await this.stretchMessages;
  }

  currentTime(): number {
    if (!this.playing) return this.pausedAt;
    const now = this.ctx.currentTime;
    return Math.min(trackTimeAt(this.anchorAt(now), now), this.duration);
  }

  /** The anchor governing the playhead from now on; null when stopped. */
  getAnchor(): PlayheadAnchor | null {
    if (!this.playing) return null;
    return { ...this.anchors[this.anchors.length - 1] };
  }

  private startOutput(startAt: number, offset: number): void {
    if (this.keyLock && this.stretch) {
      // The stretcher needs its latency as lead time to start exactly.
      const at = Math.max(startAt, this.ctx.currentTime + STRETCH_LEAD);
      this.anchors = [{ ctxTime: at, trackTime: offset, rate: this.rate }];
      this.scheduleStretch({ at, input: offset, rate: this.rate });
      this.openGate(at);
      this.stretchRunning = true;
      this.watchEnd();
      return;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.output);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.finish();
    };
    source.start(startAt, offset);
    this.source = source;
    this.anchors = [{ ctxTime: startAt, trackTime: offset, rate: this.rate }];
  }

  /** Stops whichever output is running, now or at `at`. */
  private stopOutput(at?: number): void {
    this.clearEndTimer();
    if (this.stretchRunning && this.stretch) {
      if (at === undefined) this.closeGate();
      this.parkStretch(at ?? this.ctx.currentTime);
      this.stretchRunning = false;
    }

    const source = this.source;
    if (!source) return;
    this.source = null;
    source.onended = null;
    try {
      if (at === undefined) {
        source.stop();
        source.disconnect();
      } else {
        source.stop(at);
      }
    } catch {
      // Already stopped
    }
  }

  private scheduleStretch({ at, input, rate }: { at: number; input: number; rate: number }): void {
    this.scheduleStretchAt(at, { active: true, input, rate, semitones: this.semitones });
  }

  /**
   * A parking change sent for "now" only takes effect STRETCH_LEAD later: the stretcher has
   * already rendered that far ahead. Without this an immediate stop keeps sounding for ~120 ms,
   * which automix made audible by resetting the channel to neutral the moment it stopped a deck.
   */
  private closeGate(): void {
    if (!this.gate) return;
    const now = this.ctx.currentTime;
    this.gate.gain.cancelScheduledValues(now);
    this.gate.gain.setValueAtTime(this.gate.gain.value, now);
    this.gate.gain.linearRampToValueAtTime(0, now + GATE_FADE);
  }

  /** Lets the stretcher through again from `at`, when a scheduled start begins to sound. */
  private openGate(at: number): void {
    this.gate?.gain.setValueAtTime(1, at);
  }

  /** Silences the stretcher from `at` (see PARKED_INPUT). */
  private parkStretch(at: number): void {
    this.scheduleStretchAt(at, { active: true, input: PARKED_INPUT, rate: 0 });
  }

  /**
   * The stretcher keeps a single pending change: each call replaces whatever was scheduled
   * after now, so callers only ever schedule the next change.
   */
  private scheduleStretchAt(at: number, change: StretchChange): void {
    if (!this.stretch) return;
    this.stretchMessages = this.stretch.schedule({ ...change, output: at - STRETCH_OUTPUT_DELAY });
  }

  /**
   * The stretcher plays silence past the end of the track rather than stopping (it can't
   * hold a stop behind a pending change), so a timer reports the end and stops it.
   */
  private watchEnd(): void {
    this.clearEndTimer();
    // Timers only make sense on a live clock.
    if (typeof AudioContext === 'undefined' || !(this.ctx instanceof AudioContext)) return;
    const end = ctxTimeAt(this.anchors[this.anchors.length - 1], this.duration);
    this.endTimer = setTimeout(() => this.finish(), Math.max(0, (end - this.ctx.currentTime) * 1000));
  }

  private finish(): void {
    this.clearEndTimer();
    if (this.stretchRunning) {
      this.closeGate();
      this.parkStretch(this.ctx.currentTime);
    }
    this.stretchRunning = false;
    this.playing = false;
    this.pausedAt = 0;
    this.onEnded?.();
  }

  private clearEndTimer(): void {
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
  }

  /** Latest segment in effect at `ctxTime`; the first one while a start is still pending. */
  private anchorAt(ctxTime: number): PlayheadAnchor {
    for (let i = this.anchors.length - 1; i > 0; i--) {
      if (this.anchors[i].ctxTime <= ctxTime) return this.anchors[i];
    }
    return this.anchors[0];
  }

  private nextChangeTime(): number {
    const lead = this.keyLock ? STRETCH_LEAD : SCHEDULE_LEAD;
    return alignToRenderQuantum(this.ctx.currentTime + lead, this.ctx.sampleRate);
  }

  /** Time for a change that may involve the stretcher (switching to it, or re-pitching it). */
  private handoverTime(involvesStretch: boolean): number {
    const lead = involvesStretch || this.keyLock ? STRETCH_LEAD + SCHEDULE_LEAD : SCHEDULE_LEAD;
    return alignToRenderQuantum(this.ctx.currentTime + lead, this.ctx.sampleRate);
  }
}
