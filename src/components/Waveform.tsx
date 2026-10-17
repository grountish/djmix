import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BeatClock } from '@/audio/analysis/beatClock';
import type { LoopState, Phrase, PhraseLabel, SpectralWaveform } from '@/types';

/** The next mix, in this track's bars, for drawing on its waveform. */
export interface MixMarks {
  role: 'outgoing' | 'incoming';
  /** Bar the overlap starts on (incoming track enters / this track enters). */
  startBar: number;
  /** 0 for a cut. */
  overlapBars: number;
  /** Bar of the bass swap. */
  swapBar: number;
  /** Outgoing track only: the phrase repeated under the blend. */
  loop?: { startBar: number; bars: number };
  /** True while the mix is being played. */
  live: boolean;
}

interface WaveformProps {
  data: number[];
  spectralData?: SpectralWaveform;
  currentTime: number;
  duration: number;
  bpm?: number;
  /** Beat clock of the track (beat 0 = first downbeat); the grid follows it, drift included. */
  clock?: BeatClock;
  phrases?: Phrase[];
  cuePoint?: number | null;
  marks?: MixMarks | null;
  /** The manual loop. */
  loop?: LoopState | null;
  onSeek: (time: number) => void;
}

const PHRASE_COLORS: Record<PhraseLabel, string> = {
  intro: '#5ec8c8',
  build: '#e8c547',
  drop: '#ff7a3d',
  breakdown: '#a78bfa',
  outro: '#8a8f98',
};

// Spectrum colouring: lows red-orange, mids green, highs blue-white.
const LOW_RGB = [240, 96, 56];
const MID_RGB = [96, 206, 120];
const HIGH_RGB = [132, 180, 255];

function spectralColor(low: number, mid: number, high: number): string {
  const sum = low + mid + high;
  if (sum <= 0) return 'rgb(110,110,120)';
  const channel = (i: number) => Math.round((LOW_RGB[i] * low + MID_RGB[i] * mid + HIGH_RGB[i] * high) / sum);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

const WAVE_BG = '#0b0b0f';
const PLAYHEAD = '#ff5a3c';
const CUE = '#ffffff';
const MARK_RGB: Record<MixMarks['role'], string> = { outgoing: '255,139,31', incoming: '95,193,74' };
const LOOP_RGB = '232,197,71';

/**
 * Draws the next mix over a waveform: the overlap as a band, the entry and bass swap as lines
 * (labelled when `labels`), the looped phrase hatched. `x(time)` maps track time to a pixel
 * and may return values outside [0, w].
 */
function drawMarks(
  ctx: CanvasRenderingContext2D,
  marks: MixMarks,
  clock: BeatClock,
  x: (time: number) => number,
  w: number,
  h: number,
  labels: boolean,
): void {
  const rgb = MARK_RGB[marks.role];
  const alpha = marks.live ? 1 : 0.7;
  const barX = (bar: number) => x(clock.timeOf(bar * 4));
  const loopEnd = marks.loop ? marks.loop.startBar + marks.loop.bars : Infinity;
  const x0 = barX(marks.startBar);
  // The band stops at the loop's end: from there the track repeats and can't be drawn in line.
  const x1 = barX(Math.min(marks.startBar + marks.overlapBars, loopEnd));
  const visible = (a: number, b: number) => b >= 0 && a <= w;
  ctx.save();
  if (marks.overlapBars > 0 && visible(x0, x1)) {
    const left = Math.max(0, x0);
    const right = Math.min(w, x1);
    ctx.fillStyle = `rgba(${rgb},${0.2 * alpha})`;
    ctx.fillRect(left, 0, right - left, h);
    // A solid strip along the top edge: visible however dense the waveform under it is.
    ctx.fillStyle = `rgba(${rgb},${0.9 * alpha})`;
    ctx.fillRect(left, 0, right - left, labels ? 3 : 2);
  }
  if (marks.loop) {
    const lx0 = barX(marks.loop.startBar);
    const lx1 = barX(loopEnd);
    if (visible(lx0, lx1)) {
      ctx.fillStyle = `rgba(${LOOP_RGB},${0.12 * alpha})`;
      ctx.fillRect(Math.max(0, lx0), 0, Math.min(w, lx1) - Math.max(0, lx0), h);
      ctx.strokeStyle = `rgba(${LOOP_RGB},${0.9 * alpha})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const lx of [lx0, lx1]) {
        if (lx < 0 || lx > w) continue;
        ctx.beginPath();
        ctx.moveTo(Math.floor(lx) + 0.5, 0);
        ctx.lineTo(Math.floor(lx) + 0.5, h);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (labels && lx0 >= 0 && lx0 <= w) {
        ctx.fillStyle = `rgba(${LOOP_RGB},${alpha})`;
        ctx.fillText('LOOP', lx0 + 4, h - 12);
      }
    }
  }
  const line = (px: number, label: string, dashed: boolean) => {
    if (px < 0 || px > w) return;
    ctx.strokeStyle = `rgba(${rgb},${alpha})`;
    ctx.lineWidth = dashed ? 1 : 2;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(Math.floor(px) + 0.5, 0);
    ctx.lineTo(Math.floor(px) + 0.5, h);
    ctx.stroke();
    ctx.setLineDash([]);
    if (labels) {
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.fillText(label, px + 4, h - 12);
    }
  };
  const entry = marks.overlapBars === 0 ? 'CUT' : marks.role === 'incoming' ? 'IN' : 'MIX';
  line(x0, entry, false);
  if (marks.overlapBars > 0 && marks.swapBar < loopEnd) line(barX(marks.swapBar), 'SWAP', true);
  ctx.restore();
}

/** The manual loop: a band with solid edges while it wraps, dashed while it is kept. */
function drawLoop(ctx: CanvasRenderingContext2D, loop: LoopState, x: (time: number) => number, w: number, h: number): void {
  const x0 = x(loop.start);
  const x1 = x(loop.end);
  if (x1 < 0 || x0 > w) return;
  const alpha = loop.active ? 1 : 0.55;
  ctx.save();
  const left = Math.max(0, x0);
  const right = Math.min(w, x1);
  ctx.fillStyle = `rgba(${LOOP_RGB},${0.16 * alpha})`;
  ctx.fillRect(left, 0, right - left, h);
  if (loop.active) {
    ctx.fillStyle = `rgba(${LOOP_RGB},0.9)`;
    ctx.fillRect(left, h - 3, right - left, 3);
  }
  ctx.strokeStyle = `rgba(${LOOP_RGB},${0.95 * alpha})`;
  ctx.lineWidth = loop.active ? 1.5 : 1;
  ctx.setLineDash(loop.active ? [] : [3, 3]);
  for (const lx of [x0, x1]) {
    if (lx < 0 || lx > w) continue;
    ctx.beginPath();
    ctx.moveTo(Math.floor(lx) + 0.5, 0);
    ctx.lineTo(Math.floor(lx) + 0.5, h);
    ctx.stroke();
  }
  ctx.restore();
}

// Zoom levels in bars (4 beats per bar)
const ZOOM_LEVELS = [2, 4, 8, 16, 32];
const DEFAULT_ZOOM_INDEX = 2;

/** Width-aware re-rendering: canvases redraw when their box changes size. */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function Waveform({
  data,
  spectralData,
  currentTime,
  duration,
  bpm,
  clock,
  phrases,
  cuePoint,
  marks,
  loop,
  onSeek,
}: WaveformProps) {
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [wrapperRef, width] = useElementWidth<HTMLDivElement>();
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const zoomBars = ZOOM_LEVELS[zoomIndex];
  const zoomSeconds = bpm && bpm > 0 ? (zoomBars * 4 * 60) / bpm : 16;

  // The visible window keeps the playhead centred.
  const windowDuration = Math.min(zoomSeconds, duration || zoomSeconds);
  const windowStart = Math.max(0, Math.min(Math.max(0, duration - windowDuration), currentTime - windowDuration / 2));
  const windowEnd = windowStart + windowDuration;

  const overviewPlayhead = duration > 0 ? currentTime / duration : 0;
  const viewportStart = duration > 0 ? windowStart / duration : 0;
  const viewportWidth = duration > 0 ? windowDuration / duration : 1;

  // Main zoomed waveform
  useEffect(() => {
    const canvas = mainCanvasRef.current;
    if (!canvas || data.length === 0) return;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (rect.width === 0 || rect.height === 0) return;
      if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;

      const w = rect.width;
      const h = rect.height;
      const centerY = h / 2;
      ctx.fillStyle = WAVE_BG;
      ctx.fillRect(0, 0, w, h);

      // Beat grid behind the waveform.
      if (clock && bpm && bpm > 0) {
        let beat = Math.ceil(clock.beatAt(windowStart));
        let time = clock.timeOf(beat);
        let guard = 0;
        while (time <= windowEnd && guard++ < 4096) {
          const x = Math.floor(((time - windowStart) / windowDuration) * w) + 0.5;
          const downbeat = ((beat % 4) + 4) % 4 === 0;
          ctx.strokeStyle = downbeat ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, downbeat ? 0 : h * 0.15);
          ctx.lineTo(x, downbeat ? h : h * 0.85);
          ctx.stroke();
          beat++;
          time = clock.timeOf(beat);
        }
      }

      // Waveform: one line per pixel.
      const startIdx = Math.floor((windowStart / duration) * data.length);
      const endIdx = Math.ceil((windowEnd / duration) * data.length);
      const visible = endIdx - startIdx;
      const useSpectral = !!spectralData && spectralData.low.length > 0;
      if (visible > 0) {
        const columns = Math.floor(w);
        for (let px = 0; px < columns; px++) {
          const pos = startIdx + (px / columns) * visible;
          const idx = Math.floor(pos);
          const next = Math.min(idx + 1, data.length - 1);
          const frac = pos - idx;
          const amplitude = (data[idx] || 0) * (1 - frac) + (data[next] || 0) * frac;
          const half = amplitude * centerY * 0.9;
          if (half < 0.5) continue;
          ctx.fillStyle = useSpectral
            ? spectralColor(spectralData!.low[idx] || 0, spectralData!.mid?.[idx] || 0, spectralData!.high[idx] || 0)
            : '#8ab4ff';
          ctx.fillRect(px, centerY - half, 1, half * 2);
        }
      }

      // Phrase starts, labelled.
      if (clock) {
        ctx.font = '600 9px -apple-system, "Segoe UI", sans-serif';
        ctx.textBaseline = 'top';
        for (const phrase of phrases ?? []) {
          const time = clock.timeOf(phrase.startBar * 4);
          if (time < windowStart || time > windowEnd) continue;
          const x = Math.floor(((time - windowStart) / windowDuration) * w) + 0.5;
          ctx.strokeStyle = PHRASE_COLORS[phrase.label];
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
          ctx.fillStyle = PHRASE_COLORS[phrase.label];
          ctx.fillText(phrase.label.toUpperCase(), x + 4, 3);
        }
      }

      // The next mix.
      if (marks && clock) {
        ctx.font = '700 9px -apple-system, "Segoe UI", sans-serif';
        ctx.textBaseline = 'top';
        drawMarks(ctx, marks, clock, (time) => ((time - windowStart) / windowDuration) * w, w, h, true);
      }

      if (loop) drawLoop(ctx, loop, (time) => ((time - windowStart) / windowDuration) * w, w, h);

      // Cue point.
      if (cuePoint !== null && cuePoint !== undefined && cuePoint >= windowStart && cuePoint <= windowEnd) {
        const x = Math.floor(((cuePoint - windowStart) / windowDuration) * w) + 0.5;
        ctx.strokeStyle = CUE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillStyle = CUE;
        ctx.beginPath();
        ctx.moveTo(x - 5, h);
        ctx.lineTo(x + 5, h);
        ctx.lineTo(x, h - 6);
        ctx.closePath();
        ctx.fill();
      }

      // Playhead, fixed at the centre.
      const playheadX = Math.floor(((currentTime - windowStart) / windowDuration) * w) + 0.5;
      ctx.strokeStyle = PLAYHEAD;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, h);
      ctx.stroke();
      ctx.fillStyle = PLAYHEAD;
      ctx.beginPath();
      ctx.moveTo(playheadX - 5, 0);
      ctx.lineTo(playheadX + 5, 0);
      ctx.lineTo(playheadX, 6);
      ctx.closePath();
      ctx.fill();
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [data, spectralData, currentTime, duration, windowStart, windowEnd, windowDuration, bpm, clock, phrases, cuePoint, marks, loop, width]);

  // Overview: the whole track pre-rendered once, then composited with the viewport and playhead.
  const cachedOverviewRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    if (!canvas || data.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.round(rect.width * dpr);
    offscreen.height = Math.round(rect.height * dpr);
    const ctx = offscreen.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;

    const w = rect.width;
    const h = rect.height;
    const centerY = h / 2;
    ctx.fillStyle = WAVE_BG;
    ctx.fillRect(0, 0, w, h);

    const useSpectral = !!spectralData && spectralData.low.length > 0;
    const columns = Math.floor(w);
    for (let px = 0; px < columns; px++) {
      const from = Math.floor((px / columns) * data.length);
      const to = Math.max(from + 1, Math.floor(((px + 1) / columns) * data.length));
      let amplitude = 0;
      for (let i = from; i < to; i++) amplitude = Math.max(amplitude, data[i] || 0);
      const half = amplitude * (centerY - 2) * 0.95;
      if (half < 0.3) continue;
      ctx.fillStyle = useSpectral
        ? spectralColor(spectralData!.low[from] || 0, spectralData!.mid?.[from] || 0, spectralData!.high[from] || 0)
        : '#8ab4ff';
      ctx.fillRect(px, centerY - half, 1, half * 2);
    }

    // Phrase map along the bottom edge.
    if (clock && duration > 0) {
      (phrases ?? []).forEach((phrase, i, all) => {
        const start = clock.timeOf(phrase.startBar * 4);
        const end = i + 1 < all.length ? clock.timeOf(all[i + 1].startBar * 4) : duration;
        ctx.fillStyle = PHRASE_COLORS[phrase.label];
        ctx.fillRect((start / duration) * w, h - 3, Math.max(1, ((end - start) / duration) * w), 3);
      });
    }
    cachedOverviewRef.current = offscreen;
  }, [data, spectralData, phrases, clock, duration, width]);

  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;

    const cached = cachedOverviewRef.current;
    if (cached) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(cached, 0, 0, cached.width, cached.height, 0, 0, w, h);
    } else {
      ctx.fillStyle = WAVE_BG;
      ctx.fillRect(0, 0, w, h);
    }

    // Viewport box
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(viewportStart * w, 0, viewportWidth * w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.floor(viewportStart * w) + 0.5, 0.5, Math.max(2, viewportWidth * w) - 1, h - 1);

    if (marks && clock && duration > 0) drawMarks(ctx, marks, clock, (time) => (time / duration) * w, w, h, false);
    if (loop && duration > 0) drawLoop(ctx, loop, (time) => (time / duration) * w, w, h);

    if (cuePoint !== null && cuePoint !== undefined && duration > 0) {
      const x = Math.floor((cuePoint / duration) * w) + 0.5;
      ctx.strokeStyle = CUE;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    const playheadX = Math.floor(overviewPlayhead * w) + 0.5;
    ctx.strokeStyle = PLAYHEAD;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, h);
    ctx.stroke();
  }, [overviewPlayhead, viewportStart, viewportWidth, cuePoint, marks, loop, duration, width, data, spectralData, phrases, clock]);

  const handleOverviewClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      onSeek(((e.clientX - rect.left) / rect.width) * duration);
    },
    [duration, onSeek],
  );

  const handleMainClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const time = windowStart + ((e.clientX - rect.left) / rect.width) * windowDuration;
      onSeek(Math.max(0, Math.min(duration, time)));
    },
    [windowStart, windowDuration, duration, onSeek],
  );

  return (
    <div className="wave" ref={wrapperRef}>
      <canvas ref={overviewCanvasRef} className="wave-overview" onClick={handleOverviewClick} />
      <canvas ref={mainCanvasRef} className="wave-main" onClick={handleMainClick} />
      <div className="wave-zoom">
        {ZOOM_LEVELS.map((level, idx) => (
          <button
            key={level}
            className={`zoom-btn ${idx === zoomIndex ? 'active' : ''}`}
            title={`${level} bars across`}
            onClick={() => setZoomIndex(idx)}>
            {level}
          </button>
        ))}
      </div>
    </div>
  );
}

export function EmptyWaveform() {
  return (
    <div className="wave">
      <div className="wave-overview wave-empty" />
      <div className="wave-main wave-empty wave-empty-main">
        <span>Drop a track here, or double-click one in the browser</span>
      </div>
    </div>
  );
}
