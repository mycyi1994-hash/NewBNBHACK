/**
 * Settling the house wallet's transactions (DECISIONS D-23): reconcile the outbox against the
 * chain, then write down everything that settled — awaiting cycles and transactions sent outside
 * a cycle. Runs at every tick in every execution mode and before any cycle may sign. It signs
 * nothing; at most it sends again the same bytes a person already approved (never a swap whose
 * quote went stale). What only a human can settle is alerted and keeps new signing blocked.
 */
import { acquirePlanLock, cyclesRunning, getCycle, releasePlanLock } from '@yieldvest/db';
import { applyOrphanTransactions, completeAwaitingCycles } from './awaiting.js';
import { recoverInterrupted, type CycleDeps } from './cycle.js';
import { reconcileOutbox, type Reconciliation } from './executor/send.js';
import { LOCK_TTL_MS } from './plan-lock.js';

/**
 * Cycles a dead process left 'running', recovered at every settle — not only when their plan
 * comes due again, which a paused plan (a judge's "buy now") never does. A cycle whose plan lock is
 * held is still running somewhere and is left to its holder; a dead holder's lock expires.
 */
async function recoverOrphanedCycles(deps: CycleDeps): Promise<string[]> {
  const recovered: string[] = [];
  for (const cycle of await cyclesRunning(deps.db)) {
    const held = await acquirePlanLock(deps.db, cycle.planId, deps.now(), LOCK_TTL_MS);
    if (!held) continue;
    try {
      const current = await getCycle(deps.db, cycle.id);
      if (current?.state !== 'running') continue;
      await recoverInterrupted(deps, current);
      recovered.push(`${cycle.planId}#${cycle.id}`);
    } finally {
      await releasePlanLock(deps.db, cycle.planId, held.lockUntil);
    }
  }
  return recovered;
}

export async function settleOutbox(
  deps: CycleDeps,
  options: { waitMs?: number } = {},
): Promise<Reconciliation & { completed: string[]; applied: string[] }> {
  const reconciled = await reconcileOutbox(deps, {
    from: deps.house,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  });
  for (const row of reconciled.needsHuman) {
    await deps.alerter?.send({
      key: `outbox:${row.txHash}`,
      text:
        `[yieldvest] outbox ${row.txHash}: ${row.reason}. New signing stays blocked until a human ` +
        `checks it on BscScan (RUNBOOK §3.4).`,
    });
  }
  const recovered = await recoverOrphanedCycles(deps);
  if (recovered.length > 0)
    deps.log(`settle: recovered cycles a dead process left running: ${recovered.join(', ')}`);
  const completed = await completeAwaitingCycles(deps);
  const applied = await applyOrphanTransactions(deps);
  return { ...reconciled, completed, applied };
}
