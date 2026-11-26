// Replaying a backtest like a video: the chart and the panel show only what had happened by one day (the
// cursor), and the cursor moves forward a daily candle at a time. Nothing is recomputed: the backtest already
// holds every day's value and every buy and sell, and the lines a rule looks at only ever use past days, so
// showing a prefix of them shows exactly what the rule saw then.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from './agents.ts';

const DAY = 86_400;
/** The replay starts this many daily candles before the backtest does, so the first decision has some lead-in. */
export const LEAD_DAYS = 14;
export const SPEEDS = [1, 4, 16] as const;
export type Speed = typeof SPEEDS[number];
/** Daily candles per second at 1×. */
const RATE = 15;

export interface Replay {
  /** A replay is open (playing or paused). When false, everything is shown. */
  on: boolean;
  playing: boolean;
  speed: Speed;
  /** The day being shown (seconds), or null when no replay is open. */
  cursor: number | null;
  /** 0..1 through the replay. */
  frac: number;
  start: () => void;
  toggle: () => void;
  seek: (frac: number) => void;
  setSpeed: (s: Speed) => void;
  stop: () => void;
}

/** Every day of the replay, oldest first: the lead-in, then the backtest's own days. */
export function replayDays(a: Agent): number[] {
  const out: number[] = [];
  for (let t = a.from - LEAD_DAYS * DAY; t <= a.to; t += DAY) out.push(t);
  return out;
}

export function useReplay(a: Agent | null): Replay {
  const days = useMemo(() => (a ? replayDays(a) : []), [a?.id, a?.from, a?.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const [at, setAt] = useState<number | null>(null);   // index into days
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(4);
  const last = days.length - 1;

  // Another agent or another period: the replay belongs to the one that was on screen.
  useEffect(() => { setAt(null); setPlaying(false); }, [a?.id, a?.from, a?.to]);

  const pos = useRef(0);
  useEffect(() => {
    if (!playing || at === null) return;
    pos.current = at;
    let raf = 0, prev = performance.now();
    const tick = (now: number) => {
      pos.current = Math.min(last, pos.current + ((now - prev) / 1000) * RATE * speed);
      prev = now;
      const i = Math.floor(pos.current);
      setAt(i);
      if (i >= last) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, last]); // eslint-disable-line react-hooks/exhaustive-deps

  const on = at !== null && days.length > 0;
  return {
    on, playing, speed,
    cursor: on ? days[Math.min(at!, last)] : null,
    frac: on && last > 0 ? Math.min(at!, last) / last : 0,
    start: () => { if (days.length) { setAt(0); setPlaying(true); } },
    // At the end, play starts over.
    toggle: () => { if (at === null) return; if (!playing && at >= last) setAt(0); setPlaying((p) => !p); },
    seek: (f) => { if (days.length) { setAt(Math.round(Math.max(0, Math.min(1, f)) * last)); } },
    setSpeed,
    stop: () => { setAt(null); setPlaying(false); },
  };
}
