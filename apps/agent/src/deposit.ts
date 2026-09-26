/**
 * Starting a yield plan from a job (Judge Mode's "이자로 사기", TASKS M2-02): deposit its
 * principal into Venus, record it from the confirmed receipts, and let the plan run. The deposit
 * is bounded by the plan owner's cap (sandbox for judges) and the principal cap, and refused while
 * the guardian holds deposits.
 */
import { fromUnits, nextDue, toUnits } from '@ijaro/core';
import {
  applyDeposit,
  openGuardianActions,
  planFromRow,
  updatePlan,
  type PlanRow,
} from '@ijaro/db';
import type { CycleDeps } from './cycle.js';
import { depositPrincipal } from './executor/venus.js';

export async function startYieldPlan(
  deps: CycleDeps,
  row: PlanRow,
  depositUsd: string,
): Promise<Record<string, unknown>> {
  if (!deps.venus) throw new Error('the Venus market is unavailable');
  const plan = planFromRow(row);
  const amount = toUnits(depositUsd, 18);
  const cap = String(
    plan.owner.kind === 'judge'
      ? deps.config.caps.sandboxMaxPerPlanUsd
      : deps.config.caps.maxPrincipalUsd,
  );
  if (amount <= 0n || amount > toUnits(cap, 18)) {
    throw new Error(`deposit ${depositUsd} is outside (0, ${cap}]`);
  }
  const held = (await openGuardianActions(deps.db, plan.id)).find((a) =>
    ['stop_deposits', 'redeem_all', 'pause_buys'].includes(a.action),
  );
  if (held) throw new Error(`the guardian holds new deposits: ${held.rule}`);

  const result = await depositPrincipal(deps, {
    planId: plan.id,
    market: deps.venus,
    amountUsd: depositUsd,
  });
  switch (result.kind) {
    case 'simulated':
      return { status: 'simulated', approve: result.approve, deposit: result.deposit };
    case 'pending':
      return { status: 'awaiting_tx', txHash: result.txHash };
    case 'failed':
      throw new Error(`${result.code}: ${result.message}`);
    case 'deposited': {
      for (const sent of result.sent) {
        const deposit = sent.kind === 'deposit';
        await applyDeposit(
          deps.db,
          plan.id,
          {
            kind: sent.kind,
            txHash: sent.txHash,
            broadcastVia: sent.broadcastVia,
            blockNumber: sent.receipt.blockNumber,
            status: 'success',
            simulatedAt: sent.simulatedAt,
            amounts: sent.amounts,
          },
          {
            vTokens: deposit ? result.vTokensMinted : 0n,
            usdtSpent: deposit ? result.usdtSpent : 0n,
          },
        );
      }
      const next = nextDue(plan.cadence, deps.now());
      await updatePlan(deps.db, plan.id, {
        status: 'active',
        pausedReason: null,
        ...(next.kind === 'due' ? { nextDueAt: next.nextDueAt } : {}),
      });
      return {
        status: 'deposited',
        depositedUsd: fromUnits(result.usdtSpent, 18),
        vTokens: result.vTokensMinted.toString(),
        txHashes: result.sent.map((s) => s.txHash),
      };
    }
  }
}
