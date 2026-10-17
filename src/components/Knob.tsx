import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

interface KnobProps {
  value: number;
  min?: number;
  max?: number;
  /** Where a double-click returns to; the value arc is drawn from here. */
  centre?: number;
  label: string;
  /** Tooltip, normally including the formatted value. */
  title?: string;
  size?: number;
  color?: string;
  /** Draws the arc red (an EQ band cut to silence). */
  killed?: boolean;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/** Degrees of travel between the end stops. */
const SWEEP = 270;
/** Pointer travel for the full range. */
const DRAG_PIXELS = 160;
/** Share of the range per wheel notch and per arrow key. */
const STEP = 0.02;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Point on a circle; 0° at the top, clockwise. */
function at(cx: number, cy: number, r: number, deg: number): string {
  const rad = (deg * Math.PI) / 180;
  return `${(cx + r * Math.sin(rad)).toFixed(2)} ${(cy - r * Math.cos(rad)).toFixed(2)}`;
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const [a, b] = from <= to ? [from, to] : [to, from];
  if (b - a < 0.01) return '';
  return `M ${at(cx, cy, r, a)} A ${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${at(cx, cy, r, b)}`;
}

/**
 * Rotary control in the style of a mixer knob: drag up/down (Shift for fine), scroll, arrow
 * keys, double-click to reset. Controlled: it shows `value` and reports changes.
 */
export function Knob({
  value,
  min = -1,
  max = 1,
  centre = 0,
  label,
  title,
  size = 40,
  color = 'var(--accent)',
  killed = false,
  disabled = false,
  onChange,
}: KnobProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; value: number } | null>(null);
  const latest = useRef({ value, onChange, min, max });
  latest.current = { value, onChange, min, max };

  // The wheel listener must not be passive, so the page doesn't scroll under the knob.
  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { value, onChange, min, max } = latest.current;
      const step = STEP * (max - min) * (e.shiftKey ? 0.25 : 1);
      const next = clamp(value + (e.deltaY < 0 ? step : -step), min, max);
      if (next !== value) onChange(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag.current = { y: e.clientY, value };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const range = (max - min) * (e.shiftKey ? 0.25 : 1);
    const next = clamp(drag.current.value + ((drag.current.y - e.clientY) / DRAG_PIXELS) * range, min, max);
    if (next !== value) onChange(next);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = STEP * (max - min) * (e.shiftKey ? 0.25 : 1);
    let next: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = clamp(value + step, min, max);
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = clamp(value - step, min, max);
    if (e.key === 'Home' || e.key === 'Backspace') next = centre;
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onChange(next);
  };

  const r = size / 2 - 3;
  const cx = size / 2;
  const cy = size / 2;
  const angle = (v: number) => -SWEEP / 2 + (SWEEP * (v - min)) / (max - min);
  const moved = Math.abs(value - centre) > 1e-6;
  const pointerAngle = angle(value);

  return (
    <div
      ref={ref}
      className={`knob ${moved ? 'active' : ''} ${killed ? 'killed' : ''} ${disabled ? 'disabled' : ''}`}
      style={{ width: size }}
      title={title}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => !disabled && onChange(centre)}
      onKeyDown={onKeyDown}>
      <svg className="knob-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <path className="knob-track" d={arc(cx, cy, r, -SWEEP / 2, SWEEP / 2)} />
        {moved && <path className="knob-value" d={arc(cx, cy, r, angle(centre), pointerAngle)} style={{ stroke: killed ? 'var(--red)' : color }} />}
        <circle className="knob-cap" cx={cx} cy={cy} r={r - 5} />
        <line
          className="knob-pointer"
          x1={at(cx, cy, r - 12, pointerAngle).split(' ')[0]}
          y1={at(cx, cy, r - 12, pointerAngle).split(' ')[1]}
          x2={at(cx, cy, r - 5.5, pointerAngle).split(' ')[0]}
          y2={at(cx, cy, r - 5.5, pointerAngle).split(' ')[1]}
        />
      </svg>
      <span className="knob-label">{label}</span>
    </div>
  );
}
