import { clamp } from './curves';
import {
  alignToRenderQuantum,
  type PlayheadAnchor,
  rebaseAnchor,
  SCHEDULE_LEAD,
  trackTimeAt,
} from './transport';

/**
 * Plays an AudioBuffer into a persistent deck channel. The playhead is derived from anchors
 * on the audio clock, so it stays exact across rate changes and scheduled starts.
 */
export class DeckPlayer {
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** Playhead segments in clock order; each takes over at its `ctxTime`. */
  private anchors: PlayheadAnchor[] = [];
  private rate = 1;
  private pausedAt = 0;
  private playing = false;

  onEnded?: () => void;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly output: AudioNode,
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

  load(buffer: AudioBuffer): void {
    this.stop();
    this.buffer = buffer;
  }

  /**
   * Starts at audio-clock time `when`. Without `when` it starts as soon as the audio thread
   * can honour it exactly. Returns false when there is nothing to play.
   */
  play(when?: number): boolean {
    if (!this.buffer || this.playing) return false;
    this.startSource(when ?? this.nextChangeTime(), this.pausedAt);
    this.playing = true;
    return true;
  }

  /** Stops output and keeps the playhead where it is. */
  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.currentTime();
    this.releaseSource();
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
    // Hand over from the old source to the new one at the same instant: no gap.
    const at = this.nextChangeTime();
    this.releaseSource(at);
    this.startSource(at, target);
  }

  setRate(rate: number): void {
    this.rate = rate;
    if (!this.playing || !this.source) return;

    const now = this.ctx.currentTime;
    const at = this.nextChangeTime();
    while (this.anchors.length > 1 && this.anchors[1].ctxTime <= now) {
      this.anchors.shift();
    }
    const last = this.anchors[this.anchors.length - 1];
    const rebased = rebaseAnchor(last, at, rate);
    if (rebased.ctxTime === last.ctxTime) {
      this.anchors[this.anchors.length - 1] = rebased;
    } else {
      this.anchors.push(rebased);
    }
    // playbackRate is k-rate: it is read at each block edge. An event exactly on the edge can
    // round to just after it and slip a whole block, so place it half a frame early.
    this.source.playbackRate.setValueAtTime(rate, at - 0.5 / this.ctx.sampleRate);
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

  private startSource(startAt: number, offset: number): void {
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.output);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.playing = false;
      this.pausedAt = 0;
      this.onEnded?.();
    };
    source.start(startAt, offset);

    this.source = source;
    this.anchors = [{ ctxTime: startAt, trackTime: offset, rate: this.rate }];
  }

  /** Latest segment in effect at `ctxTime`; the first one while a start is still pending. */
  private anchorAt(ctxTime: number): PlayheadAnchor {
    for (let i = this.anchors.length - 1; i > 0; i--) {
      if (this.anchors[i].ctxTime <= ctxTime) return this.anchors[i];
    }
    return this.anchors[0];
  }

  private nextChangeTime(): number {
    return alignToRenderQuantum(this.ctx.currentTime + SCHEDULE_LEAD, this.ctx.sampleRate);
  }

  private releaseSource(at?: number): void {
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
}
