// Agents someone made, kept under their account.
// There is no sign-in yet (Google and wallet sign-in are planned), so today the account is "guest": this browser.
// Everything is stored per owner, so when sign-in arrives the same code reads the signed-in account's agents and
// the guest ones can be offered for moving over. Nothing here talks to a server.
import { useSyncExternalStore } from 'react';
import type { MadeSpec } from './spec.ts';

/** Who is making agents. Sign-in will set this; until then everyone on this browser is the guest. */
export const owner = (): string => 'guest';
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
