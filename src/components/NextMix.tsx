import type { NextMix as NextMixPlan } from '@/store/AppContext';
import { describePlan } from '@/audio/automixController';

interface NextMixProps {
  next: NextMixPlan | null;
  /** Auto's own status line (countdown, mixing, errors); shown when present. */
  status: string | null;
  autoEnabled: boolean;
  incomingName: string | null;
  /** The entry has been moved by hand. */
  moved: boolean;
  onEarlier: () => void;
  onLater: () => void;
  onReset: () => void;
  onSkip: () => void;
}

/** Bars the entry moves per click: one phrase. */
const NUDGE_BARS = 8;

/**
 * Top-bar line about the next mix: what it does and when, with the entry movable a phrase at a
 * time and the cued track skippable. With Auto off it reads what Mix now would do.
 */
export function NextMix({ next, status, autoEnabled, incomingName, moved, onEarlier, onLater, onReset, onSkip }: NextMixProps) {
  const text =
    status ??
    (next && !next.live
      ? `Mix now → ${incomingName ?? '…'} · ${describePlan(next.plan)}`
      : autoEnabled
        ? 'Auto: waiting for a playing deck'
        : '');
  const editable = !!next && !next.live;
  return (
    <div className={`nextmix ${autoEnabled ? 'auto-on' : ''}`}>
      <span className="nextmix-text" title={text}>
        {text}
      </span>
      {editable && (
        <span className="nextmix-controls">
          <button className="nextmix-btn" onClick={onEarlier} title={`Bring the next track in ${NUDGE_BARS} bars earlier`}>
            ◀ {NUDGE_BARS}
          </button>
          <button className="nextmix-btn" onClick={onLater} title={`Bring the next track in ${NUDGE_BARS} bars later`}>
            {NUDGE_BARS} ▶
          </button>
          <button className={`nextmix-btn ${moved ? 'set' : ''}`} onClick={onReset} disabled={!moved} title="Back to the planned entry">
            PLAN
          </button>
          <button className="nextmix-btn" onClick={onSkip} title="Skip the cued track; Auto picks another">
            SKIP
          </button>
        </span>
      )}
    </div>
  );
}
