/**
 * Cycles held for review (PD-07). An ANOMALY — a swap that confirmed with no tokens arriving, or a
 * cycle interrupted after signing with no recorded decision — leaves a cycle out on chain that only
 * a person can settle, and pauses its plan (needs_review). While it is open every cycle of the plan
 * answers outbox_busy, so activating the plan is refused until the operator, after checking the
 * cycle's transactions on BscScan, closes it here (RUNBOOK §3.7).
 */
import type { WhyKey } from '@yieldvest/core';
import {
  acquirePlanLock,
  appendCycleStep,
  cyclesOfPlan,
  getCycle,
  outboxOfCycle,
  releasePlanLock,
  settleSpend,
  updateCycle,
  updatePlanIf,
  type CycleRow,
  type Db,
} from '@yieldvest/db';
import { heldForReview } from './awaiting.js';
import { LOCK_TTL_MS } from './plan-lock.js';

export const CLOSED_AFTER_REVIEW = 'CLOSED_AFTER_REVIEW';

/** The plan's cycles held for a person: what blocks it, oldest first. */
export async function cyclesHeldForReview(db: Db, planId: string): Promise<CycleRow[]> {
  return (await cyclesOfPlan(db, planId, ['awaiting_tx'])).filter(heldForReview);
}

export type CloseReview =
  | { kind: 'closed'; cycleId: number; confirmed: string[] }
  | { kind: 'refused'; reason: 'not_held' | 'locked' }
  | { kind: 'refused'; reason: 'unsettled'; pending: string[] };

/**
 * Closes one cycle held for review after a person checked its transactions: it ends FAILED
 * (CLOSED_AFTER_REVIEW, why.closed.review), its reservation counts as spent — a close never gives
 * a day's caps back — and a confirmed transaction of it not written down yet is applied by the next
 * settle, as any finished cycle's late transaction is. Refused while one of its transactions is
 * unsettled (the chain has not decided) or another process holds the plan. The plan stays paused,
 * now by the operator, until the person activates it.
 */
export async function closeReviewedCycle(
  deps: { db: Db; now: () => Date },
  planId: string,
  cycleId: number,
): Promise<CloseReview> {
  const lock = await acquirePlanLock(deps.db, planId, deps.now(), LOCK_TTL_MS);
  if (!lock) return { kind: 'refused', reason: 'locked' };
  try {
    const cycle = await getCycle(deps.db, cycleId);
    if (!cycle || cycle.planId !== planId || !heldForReview(cycle)) {
      return { kind: 'refused', reason: 'not_held' };
    }
    const signed = await outboxOfCycle(deps.db, cycleId);
    const pending = signed
      .filter((tx) => tx.status === 'SIGNED' || tx.status === 'PENDING')
      .map((tx) => tx.txHash);
    if (pending.length > 0) return { kind: 'refused', reason: 'unsettled', pending };
    const confirmed = signed.filter((tx) => tx.status === 'CONFIRMED').map((tx) => tx.txHash);
    await appendCycleStep(deps.db, cycleId, { step: 'CLOSED', by: 'operator' });
    await settleSpend(deps.db, cycleId, 'spent');
    await updateCycle(deps.db, cycleId, {
      state: 'done',
      outcomeKind: 'FAILED',
      outcome: {
        kind: 'FAILED',
        code: CLOSED_AFTER_REVIEW,
        message:
          'closed by the operator after checking its transactions; its receipts say what moved',
        // At least the network fee once anything confirmed; the receipts show the rest.
        fundsMoved: confirmed.length > 0 ? 'gas_only' : 'none',
      },
      whyKey: 'why.closed.review' satisfies WhyKey,
      whyParams: {},
      finishedAt: deps.now().toISOString(),
    });
    await updatePlanIf(
      deps.db,
      planId,
      { status: 'paused', pausedReason: 'needs_review' },
      { status: 'paused', pausedReason: 'paused_by_operator' },
    );
    return { kind: 'closed', cycleId, confirmed };
  } finally {
    await releasePlanLock(deps.db, planId, lock.lockUntil);
  }
}
