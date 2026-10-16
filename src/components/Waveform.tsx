import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { Phrase, PhraseLabel, SpectralWaveform } from '@/types';

interface WaveformProps {
  data: number[];
  spectralData?: SpectralWaveform;
  currentTime: number;
  duration: number;
  bpm?: number;
  firstBeatTime?: number;
  phrases?: Phrase[];
  onSeek: (time: number) => void;
}

const PHRASE_COLORS: Record<PhraseLabel, string> = {
  intro: '#5ec8c8',
  build: '#e8c547',
  drop: '#ff7a3d',
  breakdown: '#a78bfa',
  outro: '#8a8f98',
};

function phraseStartTime(phrase: Phrase, firstBeatTime: number, bpm: number): number {
  return firstBeatTime + (phrase.startBar * 4 * 60) / bpm;
}

// Zoom levels in bars (4 beats per bar)
const ZOOM_LEVELS = [2, 4, 8, 16, 32];
const DEFAULT_ZOOM_INDEX = 2; // 8 bars

export function Waveform({
  data,
  spectralData,
  currentTime,
  duration,
  bpm,
  firstBeatTime = 0,
  phrases,
  onSeek,
}: WaveformProps) {
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  // Calculate zoom in seconds based on BPM and bar count
  const zoomBars = ZOOM_LEVELS[zoomIndex];
  const beatsWindow = zoomBars * 4;
  const zoomSeconds = bpm && bpm > 0 ? (beatsWindow * 60) / bpm : 16;

  // Calculate visible window - playhead is ALWAYS at center
  const windowDuration = Math.min(zoomSeconds, duration);
  const halfWindow = windowDuration / 2;
  const windowStart = Math.max(0, Math.min(duration - windowDuration, currentTime - halfWindow));
  const windowEnd = windowStart + windowDuration;

  // Overview calculations
  const overviewPlayhead = duration > 0 ? (currentTime / duration) * 100 : 0;
  const viewportStart = duration > 0 ? (windowStart / duration) * 100 : 0;
  const viewportWidth = duration > 0 ? (windowDuration / duration) * 100 : 100;

  // Draw main zoomed waveform using requestAnimationFrame
  useEffect(() => {
    const canvas = mainCanvasRef.current;
    if (!canvas || data.length === 0) return;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // Only resize if needed
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.imageSmoothingEnabled = false;

      const width = rect.width;
      const height = rect.height;
      const centerY = height / 2;

      // Dark background
      ctx.fillStyle = '#0a0a14';
      ctx.fillRect(0, 0, width, height);

      // Draw waveform - Traktor style with thin 1px lines
      const startIdx = Math.floor((windowStart / duration) * data.length);
      const endIdx = Math.ceil((windowEnd / duration) * data.length);
      const visibleSamples = endIdx - startIdx;

      if (visibleSamples > 0) {
        const useSpectral = spectralData && spectralData.low.length > 0;

        // Draw one line per pixel for maximum detail
        const numLines = Math.floor(width);

        for (let px = 0; px < numLines; px++) {
          // Get interpolated data position
          const dataPos = startIdx + (px / numLines) * visibleSamples;
          const dataIdx = Math.floor(dataPos);
          const nextIdx = Math.min(dataIdx + 1, data.length - 1);
          const frac = dataPos - dataIdx;

          // Interpolate amplitude for smooth waveform
          const amp1 = data[dataIdx] || 0;
          const amp2 = data[nextIdx] || 0;
          const amplitude = amp1 * (1 - frac) + amp2 * frac;

          const lineHeight = amplitude * centerY * 0.85;

          if (lineHeight < 0.5) continue; // Skip silent parts

          // Spectral coloring - Traktor style
          let r: number, g: number, b: number;
          if (useSpectral) {
            const low = spectralData.low[dataIdx] || 0;
            const mid = spectralData.mid ? spectralData.mid[dataIdx] || 0 : 0.5;
            const high = spectralData.high[dataIdx] || 0;

            // Bass = blue/cyan, mids = green/teal, highs = orange/yellow
            if (low > high && low > mid) {
              // Bass dominant - blue gradient
              r = Math.floor(40 + low * 60);
              g = Math.floor(120 + low * 80);
              b = Math.floor(180 + low * 75);
            } else if (high > low && high > mid) {
              // High dominant - orange/yellow
              r = Math.floor(200 + high * 55);
              g = Math.floor(150 + high * 80);
              b = Math.floor(50 + high * 30);
            } else {
              // Mid dominant - cyan/teal
              r = Math.floor(60 + mid * 80);
              g = Math.floor(180 + mid * 60);
              b = Math.floor(160 + mid * 60);
            }
          } else {
            // Default cyan
            r = 78;
            g = 205;
            b = 196;
          }

          // Draw vertical line (1px wide)
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(px, centerY - lineHeight, 1, lineHeight * 2);
        }
      }

      // Draw beat grid on top (subtle)
      if (bpm && bpm > 0) {
        const beatDuration = 60 / bpm;
        // Beat 0 is the first downbeat; the grid extends before it too.
        let beatCount = Math.ceil((windowStart - firstBeatTime) / beatDuration);
        let beatTime = firstBeatTime + beatCount * beatDuration;

        ctx.globalCompositeOperation = 'lighter';
        while (beatTime <= windowEnd) {
          const x = ((beatTime - windowStart) / windowDuration) * width;
          const isDownbeat = ((beatCount % 4) + 4) % 4 === 0;

          ctx.strokeStyle = isDownbeat ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.08)';
          ctx.lineWidth = isDownbeat ? 1 : 0.5;
          ctx.beginPath();
          ctx.moveTo(Math.floor(x) + 0.5, 0);
          ctx.lineTo(Math.floor(x) + 0.5, height);
          ctx.stroke();

          beatTime += beatDuration;
          beatCount++;
        }
        ctx.globalCompositeOperation = 'source-over';

        // Phrase starts, labelled
        ctx.font = '9px sans-serif';
        ctx.textBaseline = 'top';
        for (const phrase of phrases ?? []) {
          const time = phraseStartTime(phrase, firstBeatTime, bpm);
          if (time < windowStart || time > windowEnd) continue;
          const x = Math.floor(((time - windowStart) / windowDuration) * width) + 0.5;
          ctx.strokeStyle = PHRASE_COLORS[phrase.label];
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
          ctx.fillStyle = PHRASE_COLORS[phrase.label];
          ctx.fillText(phrase.label.toUpperCase(), x + 3, 2);
        }
      }

      // Center line (subtle)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.stroke();

      // Draw playhead - fixed at center with glow
      const playheadX = ((currentTime - windowStart) / windowDuration) * width;

      // Glow
      ctx.shadowColor = '#ff4444';
      ctx.shadowBlur = 8;
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Inner bright line
      ctx.strokeStyle = '#ff6666';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    };

    // Use RAF for smooth animation
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [
    data,
    spectralData,
    currentTime,
    duration,
    windowStart,
    windowEnd,
    windowDuration,
    bpm,
    firstBeatTime,
    phrases,
  ]);

  // Cache for overview waveform
  const cachedOverviewRef = useRef<HTMLCanvasElement | null>(null);

  // Pre-render overview waveform (only when data changes)
  useEffect(() => {
    if (data.length === 0) return;

    const canvas = overviewCanvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const offscreen = document.createElement('canvas');
    offscreen.width = rect.width * dpr;
    offscreen.height = 24 * dpr;

    const ctx = offscreen.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;

    const width = rect.width;
    const height = 24;
    const centerY = height / 2;

    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, width, height);

    // Draw 1px lines for overview too
    const numLines = Math.floor(width);
    const useSpectral = spectralData && spectralData.low.length > 0;

    for (let px = 0; px < numLines; px++) {
      const dataIdx = Math.floor((px / numLines) * data.length);
      const amplitude = data[dataIdx] || 0;
      const lineHeight = amplitude * centerY * 0.85;

      if (lineHeight < 0.3) continue;

      if (useSpectral) {
        const low = spectralData.low[dataIdx] || 0;
        const mid = spectralData.mid ? spectralData.mid[dataIdx] || 0 : 0.5;
        const high = spectralData.high[dataIdx] || 0;

        let r: number, g: number, b: number;
        if (low > high && low > mid) {
          r = Math.floor(40 + low * 60);
          g = Math.floor(120 + low * 80);
          b = Math.floor(180 + low * 75);
        } else if (high > low && high > mid) {
          r = Math.floor(200 + high * 55);
          g = Math.floor(150 + high * 80);
          b = Math.floor(50 + high * 30);
        } else {
          r = Math.floor(60 + mid * 80);
          g = Math.floor(180 + mid * 60);
          b = Math.floor(160 + mid * 60);
        }
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      } else {
        ctx.fillStyle = '#4ecdc4';
      }

      ctx.fillRect(px, centerY - lineHeight, 1, lineHeight * 2);
    }

    // Phrase map along the bottom edge
    if (bpm && bpm > 0 && duration > 0) {
      (phrases ?? []).forEach((phrase, i, all) => {
        const start = phraseStartTime(phrase, firstBeatTime, bpm);
        const end = i + 1 < all.length ? phraseStartTime(all[i + 1], firstBeatTime, bpm) : duration;
        ctx.fillStyle = PHRASE_COLORS[phrase.label];
        ctx.fillRect((start / duration) * width, height - 3, ((end - start) / duration) * width, 3);
      });
    }

    cachedOverviewRef.current = offscreen;
  }, [data, spectralData, phrases, bpm, firstBeatTime, duration]);

  // Draw overview with viewport and playhead (fast - just compositing)
  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    // Draw cached waveform or clear
    const cached = cachedOverviewRef.current;
    if (cached) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(cached, 0, 0, cached.width, cached.height, 0, 0, width, height);
    } else {
      ctx.fillStyle = '#0a0a14';
      ctx.fillRect(0, 0, width, height);
    }

    // Draw viewport indicator
    const vpX = (viewportStart / 100) * width;
    const vpW = (viewportWidth / 100) * width;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(vpX, 0, vpW, height);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(vpX, 0, vpW, height);

    // Draw playhead
    const playheadX = (overviewPlayhead / 100) * width;
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }, [overviewPlayhead, viewportStart, viewportWidth]);

  const handleOverviewClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = x / rect.width;
      onSeek(percent * duration);
    },
    [duration, onSeek],
  );

  const handleMainClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = x / rect.width;
      const time = windowStart + percent * windowDuration;
      onSeek(Math.max(0, Math.min(duration, time)));
    },
    [windowStart, windowDuration, duration, onSeek],
  );

  return (
    <div className="waveform-wrapper">
      {/* Main zoomed waveform */}
      <canvas ref={mainCanvasRef} className="waveform-main-canvas" onClick={handleMainClick} />

      {/* Overview strip */}
      <canvas
        ref={overviewCanvasRef}
        className="waveform-overview-canvas"
        onClick={handleOverviewClick}
      />

      {/* Zoom buttons */}
      <div className="waveform-zoom-buttons">
        {ZOOM_LEVELS.map((level, idx) => (
          <button
            key={level}
            className={`zoom-button ${idx === zoomIndex ? 'active' : ''}`}
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
    <div className="waveform-wrapper">
      <div className="waveform-main-empty">
        <span>No track loaded</span>
      </div>
      <div className="waveform-overview-empty" />
    </div>
  );
}
