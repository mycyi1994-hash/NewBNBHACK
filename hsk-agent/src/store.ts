// Hired agents and trades run from the chat, saved in this browser. The hired agent is the one source of
// truth for amounts, state and profit; Moa and the bar read it, they do not keep their own copy.
import { useCallback, useState } from 'react';
import type { HiredAgent } from './runner.ts';

export interface Execution {
  at: number;
  ok: boolean;
  asset: string;
  side: string;
  amount: number;
  reason?: string;
  txHash?: string;
  explorerUrl?: string;
  amountIn?: string;
  amountOut?: string;
  tokenIn?: string;
  tokenOut?: string;
}

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function write<T>(key: string, v: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable (private window); data lives for this session only */
  }
}

const HIRED = 'moa.hired.v1';

export function useHired() {
  const [hired, setHired] = useState<HiredAgent[]>(() => read<HiredAgent>(HIRED));
  const commit = (fn: (cur: HiredAgent[]) => HiredAgent[]) => setHired((cur) => { const next = fn(cur); write(HIRED, next); return next; });
  const add = useCallback((h: HiredAgent) => commit((cur) => [h, ...cur]), []); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useCallback((id: string, fn: (h: HiredAgent) => HiredAgent) => commit((cur) => cur.map((h) => (h.id === id ? fn(h) : h))), []); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = useCallback((id: string) => commit((cur) => cur.filter((h) => h.id !== id)), []); // eslint-disable-line react-hooks/exhaustive-deps
  return { hired, add, update, remove };
}

export function useExecutions() {
  const [execs, setExecs] = useState<Execution[]>(() => read<Execution>('moa.execs.v1'));
  const record = useCallback((xs: Execution[]) => {
    if (!xs.length) return;
    setExecs((prev) => { const next = [...xs, ...prev].slice(0, 200); write('moa.execs.v1', next); return next; });
  }, []);
  return { execs, record };
}
