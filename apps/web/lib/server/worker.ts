/**
 * The worker's heartbeat as the web reads it: worker_status 'tick' is written at the end of every
 * tick, and the guardian runs inside every tick (apps/agent/src/scheduler.ts). The smoke check and
 * the pre-flight view read the same freshness rule from here.
 */
import { isoTime, openGuardianActions, readWorkerStatus, type Db } from '@yieldvest/db';

/** The worker ticks every five minutes: three missed ticks make it stale. */
export const TICK_FRESH_MS = 15 * 60_000;

export interface GuardianState {
  /** When the worker last finished a tick; null when it never did. */
  checkedAt: string | null;
  /**
   * The last tick is recent and its guardian step did not fail. Otherwise nobody has checked the
   * rules lately, and a missing verdict never reads as "all clear".
   */
  fresh: boolean;
  /** Open verdicts that apply to every plan (plan-specific ones belong to their plan). */
  open: { rule: string; action: string }[];
}

export async function guardianState(db: Db, now: Date): Promise<GuardianState> {
  const [tick, open] = await Promise.all([readWorkerStatus(db, 'tick'), openGuardianActions(db)]);
  const checkedAt = tick ? isoTime(tick.updatedAt) : null;
  const errors = Array.isArray(tick?.value.errors) ? (tick.value.errors as unknown[]) : [];
  const guardianFailed = errors.some((e) => typeof e === 'string' && /^guardian\b/.test(e));
  const recent = checkedAt !== null && now.getTime() - Date.parse(checkedAt) <= TICK_FRESH_MS;
  return { checkedAt, fresh: recent && !guardianFailed, open };
}
