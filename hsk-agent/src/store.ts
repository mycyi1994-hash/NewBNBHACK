// Hired agents and trades run from the chat, saved in this browser under their owner: the wallet that logged in,
// or the guest before that. The hired agent is the one source of truth for amounts, state and profit; Moa and the
// bar read it, they do not keep their own copy.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HiredAgent } from './runner.ts';
import { owner, useSession } from './account.ts';

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

/** The guest keeps the original key; each wallet gets its own. */
const keyFor = (name: string, who: string) => (who === 'guest' ? `moa.${name}.v1` : `moa.${name}.v1.${who}`);

/**
 * A list kept per owner. Logging in or out swaps it for that owner's list. A wallet logging in for the first time
 * with nothing saved takes over what the guest had, so agents hired before logging in are not lost.
 */
function useOwned<T>(name: string) {
  useSession();
  const who = owner();
  const keyRef = useRef(keyFor(name, who));
  const [list, setList] = useState<T[]>(() => read<T>(keyRef.current));
  useEffect(() => {
    const key = keyFor(name, who);
    if (key === keyRef.current) return;
    keyRef.current = key;
    let next = read<T>(key);
    if (who !== 'guest' && !next.length) { next = read<T>(keyFor(name, 'guest')); if (next.length) write(key, next); }
    setList(next);
  }, [name, who]);
  const commit = useCallback((fn: (cur: T[]) => T[]) => setList((cur) => { const next = fn(cur); write(keyRef.current, next); return next; }), []);
  return [list, commit] as const;
}

export function useHired() {
  const [hired, commit] = useOwned<HiredAgent>('hired');
  const add = useCallback((h: HiredAgent) => commit((cur) => [h, ...cur]), [commit]);
  const update = useCallback((id: string, fn: (h: HiredAgent) => HiredAgent) => commit((cur) => cur.map((h) => (h.id === id ? fn(h) : h))), [commit]);
  const remove = useCallback((id: string) => commit((cur) => cur.filter((h) => h.id !== id)), [commit]);
  return { hired, add, update, remove };
}

export function useExecutions() {
  const [execs, commit] = useOwned<Execution>('execs');
  const record = useCallback((xs: Execution[]) => { if (xs.length) commit((prev) => [...xs, ...prev].slice(0, 200)); }, [commit]);
  return { execs, record };
}
