// Bots the user has created in this browser. Execution is not wired yet, so every bot is a draft.
import { useCallback, useState } from 'react';
import type { Plan } from './intent.ts';

export interface Bot {
  id: string;
  name: string;
  goal: string;
  plan: Plan;
  createdAt: number;
  status: 'draft';
}

const KEY = 'moa.bots.v1';

function read(): Bot[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Bot[]) : [];
  } catch {
    return [];
  }
}

function write(bots: Bot[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(bots));
  } catch {
    /* storage unavailable (private window); bots live for this session only */
  }
}

export function useBots() {
  const [bots, setBots] = useState<Bot[]>(read);
  const add = useCallback((b: Omit<Bot, 'id' | 'createdAt' | 'status'>) => {
    const bot: Bot = { ...b, id: Math.random().toString(36).slice(2, 10), createdAt: Date.now(), status: 'draft' };
    setBots((prev) => {
      const next = [bot, ...prev];
      write(next);
      return next;
    });
    return bot;
  }, []);
  const remove = useCallback((id: string) => {
    setBots((prev) => {
      const next = prev.filter((b) => b.id !== id);
      write(next);
      return next;
    });
  }, []);
  return { bots, add, remove };
}
