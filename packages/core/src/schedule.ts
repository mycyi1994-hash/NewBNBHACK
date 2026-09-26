/**
 * When a plan is due next (SPEC §5.9). A deferred cycle waits for its own retryAt; any other
 * outcome moves the plan to the next slot of its cadence — daily: the next regular open + 2 min,
 * weekly: the first regular open at least six days on + 2 min — and a `once` plan stops. A FAILED
 * cycle is not retried sooner: the same spend is never repeated automatically.
 */
import { OPEN_SETTLE_MS } from './decide.js';
import { nextRegularOpen } from './session.js';
import type { Cadence } from './types.js';

const DAY_MS = 86_400_000;

export type NextDue = { kind: 'due'; nextDueAt: string } | { kind: 'stop' };

/** `retryAt`: the DEFERRED outcome's retry time; omit for every other outcome. */
export function nextDue(cadence: Cadence, now: Date, retryAt?: string): NextDue {
  if (retryAt !== undefined) return { kind: 'due', nextDueAt: retryAt };
  if (cadence === 'once') return { kind: 'stop' };
  const from = cadence === 'weekly' ? new Date(now.getTime() + 6 * DAY_MS) : now;
  const open = nextRegularOpen(from).getTime() + OPEN_SETTLE_MS;
  return { kind: 'due', nextDueAt: new Date(open).toISOString() };
}
