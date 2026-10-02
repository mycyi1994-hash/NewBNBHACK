/**
 * The plan lock's lifetime, shared by everything that writes a plan's money columns or signs for
 * it: a cycle, a whole-position redeem (stop, guardian, operator) and a deposit.
 */
import { renewPlanLock, type Db } from '@yieldvest/db';

/** The lock outlives the longest step between two renewals (one receipt wait of three minutes). */
export const LOCK_TTL_MS = 12 * 60_000;

/** The lock lapsed and another holder took it over: this one must not write or sign again. */
export class LockLostError extends Error {
  constructor(planId: string) {
    super(`the lock of plan ${planId} was taken over; its new holder decides from now on`);
    this.name = 'LockLostError';
  }
}

export interface PlanLease {
  /** The value the lock holds now: what releasePlanLock compares. */
  until: () => string | null;
  /** Renews the lock for another LOCK_TTL_MS; throws LockLostError when it was taken over. */
  hold: () => Promise<void>;
}

/**
 * A held plan lock, renewed before every step that must not run without it: a reservation, a
 * signature, the final write. A lock is only a lease — once it lapses, any settle may recover the
 * plan's running cycle (settlement.ts) — so a cycle slower than LOCK_TTL_MS that kept going would
 * sign for a cycle already closed, against a reservation already freed.
 */
export function planLease(
  db: Db,
  planId: string,
  lockUntil: string | null,
  now: () => Date,
): PlanLease {
  let until = lockUntil;
  return {
    until: () => until,
    hold: async () => {
      const renewed =
        until === null ? undefined : await renewPlanLock(db, planId, until, now(), LOCK_TTL_MS);
      if (renewed === undefined) {
        until = null;
        throw new LockLostError(planId);
      }
      until = renewed;
    },
  };
}
