import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BeatClock } from '@/audio/analysis/beatClock';
import type { Phrase, PhraseLabel, SpectralWaveform } from '@/types';

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
  }, [data, spectralData, currentTime, duration, windowStart, windowEnd, windowDuration, bpm, clock, phrases, cuePoint, width]);

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
  }, [overviewPlayhead, viewportStart, viewportWidth, cuePoint, duration, width, data, spectralData, phrases, clock]);

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
