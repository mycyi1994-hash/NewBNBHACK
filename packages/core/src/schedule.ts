/**
 * When a plan is due next (SPEC §5.9). A deferred cycle waits for its own retryAt; any other
 * outcome moves the plan to the next slot of its cadence — daily: the first regular open after
 * the New York date of the run, weekly: the first regular open on or after the same weekday one
 * week later — each + 2 min, and a `once` plan stops. Steps are New York calendar days, so a DST
 * switch never shortens a week, and a buy before the open is not followed by another the same
 * day. A FAILED cycle is not retried sooner: the same spend is never repeated automatically.
 */
import { OPEN_SETTLE_MS } from './decide.js';
import { addNewYorkDays, firstOpenOnOrAfter, newYorkParts } from './session.js';
import type { Cadence } from './types.js';

export type NextDue = { kind: 'due'; nextDueAt: string } | { kind: 'stop' };

/** `retryAt`: the DEFERRED outcome's retry time; omit for every other outcome. */
export function nextDue(cadence: Cadence, now: Date, retryAt?: string): NextDue {
  if (retryAt !== undefined) return { kind: 'due', nextDueAt: retryAt };
  if (cadence === 'once') return { kind: 'stop' };
  const from = addNewYorkDays(newYorkParts(now).date, cadence === 'weekly' ? 7 : 1);
  const open = firstOpenOnOrAfter(from).getTime() + OPEN_SETTLE_MS;
  return { kind: 'due', nextDueAt: new Date(open).toISOString() };
}
