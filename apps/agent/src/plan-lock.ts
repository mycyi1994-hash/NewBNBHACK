/**
 * The plan lock's lifetime, shared by everything that writes a plan's money columns or signs for
 * it: a cycle, a whole-position redeem (stop, guardian, operator) and a deposit.
 */

/** The lock outlives the longest cycle (three receipt waits of three minutes). */
export const LOCK_TTL_MS = 12 * 60_000;
