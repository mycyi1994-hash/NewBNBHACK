/**
 * Settling the house wallet's transactions (DECISIONS D-23): reconcile the outbox against the
 * chain, then write down everything that settled — awaiting cycles and transactions sent outside
 * a cycle. Runs at every tick in every execution mode and before any cycle may sign. It signs
 * nothing; at most it sends again the same bytes a person already approved (never a swap whose
 * quote went stale). What only a human can settle is alerted and keeps new signing blocked.
 */
import { applyOrphanTransactions, completeAwaitingCycles } from './awaiting.js';
import type { CycleDeps } from './cycle.js';
import { reconcileOutbox, type Reconciliation } from './executor/send.js';

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
  const completed = await completeAwaitingCycles(deps);
  const applied = await applyOrphanTransactions(deps);
  return { ...reconciled, completed, applied };
}
