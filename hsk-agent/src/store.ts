// Bots and executed trades saved in this browser. Bots are drafts until automatic runs exist.
import { useCallback, useState } from 'react';
import type { Plan } from './intent.ts';

export interface Bot {
  id: string;
  name: string;
  goal: string;
  plan: Plan;
  createdAt: number;
  /** Start of the conversation that made this bot; fills from then on belong to it. */
  since?: number;
  status: 'draft';
}

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

export function useBots() {
  const [bots, setBots] = useState<Bot[]>(() => read<Bot>('moa.bots.v1'));
  const add = useCallback((b: Omit<Bot, 'id' | 'createdAt' | 'status'>) => {
    const bot: Bot = { ...b, id: Math.random().toString(36).slice(2, 10), createdAt: Date.now(), status: 'draft' };
    setBots((prev) => { const next = [bot, ...prev]; write('moa.bots.v1', next); return next; });
    return bot;
  }, []);
  const remove = useCallback((id: string) => {
    setBots((prev) => { const next = prev.filter((b) => b.id !== id); write('moa.bots.v1', next); return next; });
  }, []);
  return { bots, add, remove };
}

export function useExecutions() {
  const [execs, setExecs] = useState<Execution[]>(() => read<Execution>('moa.execs.v1'));
  const record = useCallback((xs: Execution[]) => {
    if (!xs.length) return;
    setExecs((prev) => { const next = [...xs, ...prev].slice(0, 200); write('moa.execs.v1', next); return next; });
  }, []);
  return { execs, record };
}
