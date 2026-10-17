import { useEffect, useRef } from 'react';

interface MeterProps {
  analyser: AnalyserNode | null;
  className?: string;
}

/** RMS level shown as 0 on the meter. */
const FLOOR_DB = -42;
/** Fall-back per frame (share of the scale) once the signal drops. */
const DECAY = 0.012;
const PEAK_HOLD_FRAMES = 45;
/** Scale positions where the colour turns yellow, then red. */
const YELLOW_FROM = 0.72;
const RED_FROM = 0.9;

/** Vertical level meter fed by an AnalyserNode: RMS with a held peak, LED-style segments. */
export function Meter({ analyser, className = '' }: MeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const samples = analyser ? new Float32Array(analyser.fftSize) : null;
    let level = 0;
    let peak = 0;
    let peakAge = 0;
    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (rect.width === 0 || rect.height === 0) return;
      if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }

      let instant = 0;
      if (analyser && samples) {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const db = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
        instant = Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
      }
      level = instant >= level ? instant : Math.max(instant, level - DECAY);
      if (instant >= peak) {
        peak = instant;
        peakAge = 0;
      } else if (++peakAge > PEAK_HOLD_FRAMES) {
        peak = Math.max(instant, peak - DECAY);
      }

      const w = rect.width;
      const h = rect.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(0, 0, w, h);

      const gradient = ctx.createLinearGradient(0, h, 0, 0);
      gradient.addColorStop(0, '#3fae4a');
      gradient.addColorStop(YELLOW_FROM - 0.01, '#3fae4a');
      gradient.addColorStop(YELLOW_FROM, '#e0c13a');
      gradient.addColorStop(RED_FROM - 0.01, '#e0c13a');
      gradient.addColorStop(RED_FROM, '#ff4b4b');
      gradient.addColorStop(1, '#ff4b4b');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, h - level * h, w, level * h);

      // LED gaps.
      ctx.fillStyle = '#0d0d0d';
      for (let y = h - 3; y > 0; y -= 3) ctx.fillRect(0, y, w, 1);

      if (peak > 0.02) {
        const y = Math.round(h - peak * h);
        ctx.fillStyle = peak >= RED_FROM ? '#ff4b4b' : peak >= YELLOW_FROM ? '#e0c13a' : '#7fd98a';
        ctx.fillRect(0, Math.max(0, y - 1), w, 2);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  return <canvas ref={canvasRef} className={`meter ${className}`} />;
}
