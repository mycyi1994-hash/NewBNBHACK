// Agents someone made, kept under their account: the wallet that logged in, or "guest" (this browser) before that.
// Everything is stored per owner. The first time a wallet logs in with nothing saved, the guest's agents come along.
// Nothing here talks to a server.
import { useSyncExternalStore } from 'react';
import type { MadeSpec } from './spec.ts';
import { onOwnerChange, owner } from './account.ts';

export { owner };
const key = () => `moa.made.v1.${owner()}`;
export const MADE_PREFIX = 'made:';

let cache: { key: string; list: MadeSpec[] } | null = null;
const listeners = new Set<() => void>();
function read(): MadeSpec[] {
  const k = key();
  if (cache?.key === k) return cache.list;
  let list: MadeSpec[] = [];
  try { const v = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(k) ?? '[]'); if (Array.isArray(v)) list = v.filter((x) => x && typeof x.id === 'string' && Array.isArray(x.buy) && Array.isArray(x.sell)); } catch { /* storage unavailable */ }
  cache = { key: k, list };
  return list;
}
function write(list: MadeSpec[]) {
  cache = { key: key(), list };
  try { localStorage.setItem(key(), JSON.stringify(list)); } catch { /* storage unavailable: kept for this visit only */ }
  listeners.forEach((f) => f());
}

// Logging in or out switches whose agents are shown.
onOwnerChange(() => {
  if (owner() !== 'guest' && !read().length) {
    try { const guest = JSON.parse(localStorage.getItem('moa.made.v1.guest') ?? '[]') as MadeSpec[]; if (Array.isArray(guest) && guest.length) { write(guest); return; } } catch { /* nothing to bring */ }
  }
  listeners.forEach((f) => f());
});

export const madeList = (): MadeSpec[] => read();
export const madeById = (agentId: string): MadeSpec | undefined => read().find((s) => MADE_PREFIX + s.id === agentId);
/** Add a new agent or replace the one with the same id. */
export function saveMade(spec: MadeSpec) { const rest = read().filter((s) => s.id !== spec.id); write([spec, ...rest]); }
export function removeMade(id: string) { write(read().filter((s) => s.id !== id)); }
export const newMadeId = () => Math.random().toString(36).slice(2, 10);

/** The made agents, re-rendering when one is saved or removed. */
export function useMade(): MadeSpec[] {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, read, read);
}
