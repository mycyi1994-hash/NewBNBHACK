/**
 * Starting a yield plan from a job (Judge Mode's "Buy with interest", TASKS M2-02): deposit its
 * principal into Venus, record it from the confirmed receipts, and let the plan run. The deposit
 * is bounded by the plan owner's cap (sandbox for judges) and the principal cap, and refused while
 * the guardian holds deposits.
 */
import { fromUnits, nextDue, toUnits } from '@yieldvest/core';
import {
  applyDeposit,
  getPlan,
  judgeExposureUsd,
  listPlans,
  openGuardianActions,
  planFromRow,
  unfinishedTransactions,
  updatePlanIf,
  usdText,
  type PlanRow,
} from '@yieldvest/db';
import type { CycleDeps } from './cycle.js';
import { depositPrincipal } from './executor/venus.js';
import { PublicError } from './public-error.js';
import { settleOutbox } from './settlement.js';

/** How long a deposit job waits for an earlier transaction's receipt before it refuses. */
const SETTLE_WAIT_MS = 5_000;

export async function startYieldPlan(
  deps: CycleDeps,
  row: PlanRow,
  depositUsd: string,
): Promise<Record<string, unknown>> {
  if (!deps.venus) throw new PublicError('the Venus market is unavailable');
  const plan = planFromRow(row);
  const amount = toUnits(depositUsd, 18);
  const cap = String(
    plan.owner.kind === 'judge'
      ? deps.config.caps.sandboxMaxPerPlanUsd
      : deps.config.caps.maxPrincipalUsd,
  );
  if (amount <= 0n || amount > toUnits(cap, 18)) {
    throw new PublicError(`deposit ${depositUsd} is outside (0, ${cap}]`);
  }
  const held = (await openGuardianActions(deps.db, plan.id)).find((a) =>
    ['stop_deposits', 'redeem_all', 'pause_buys'].includes(a.action),
  );
  if (held) throw new PublicError(`the guardian holds new deposits: ${held.rule}`);
  if (deps.mode === 'live') {
    // One signer for every plan (D-23): what was sent before settles, and is written down, first —
    // so a judge who tries again after "approval_pending" goes on from the mined approval at once,
    // not after the next tick.
    await settleOutbox(deps, { waitMs: SETTLE_WAIT_MS });
  }
  // One deposit at a time: a deposit still settling would otherwise be sent a second time (its
  // principal is recorded only from its receipt). For a judge, across all the code's plans, and
  // the code's principal plus its spend stays within the sandbox cap in total.
  const siblings =
    plan.owner.kind === 'judge' && row.ownerRef !== null
      ? await listPlans(deps.db, { ownerKind: 'judge', ownerRef: row.ownerRef })
      : [row];
  for (const sibling of siblings) {
    const unfinished = await unfinishedTransactions(deps.db, sibling.id);
    if (unfinished.length === 0) continue;
    // Only this plan's own exact approval, still confirming: the judge who tries again is told
    // so again (and can try once more), never handed a failure that ends the retry.
    const approving = unfinished.at(-1);
    if (sibling.id === plan.id && approving && unfinished.every((tx) => tx.kind === 'approve')) {
      return { status: 'approval_pending', txHash: approving.txHash };
    }
    throw new PublicError('an earlier transaction of this plan is still settling');
  }
  // Read again after the settle: it may just have written down this plan's own first deposit,
  // mined late (the job that sent it stopped waiting). Asked again — the documented API, or a
  // judge pressing the button once more — the plan is not sent a second deposit.
  const fresh = (await getPlan(deps.db, plan.id)) ?? row;
  const principal = toUnits(usdText(fresh.principalUsd), 18);
  if (principal > 0n) {
    return {
      status: 'deposited',
      depositedUsd: fromUnits(principal, 18),
      vTokens: fresh.vtokenUnits,
      txHashes: [],
      alreadyRecorded: true,
    };
  }
  if (plan.owner.kind === 'judge' && row.ownerRef !== null) {
    const used = toUnits(usdText(await judgeExposureUsd(deps.db, row.ownerRef)), 18);
    if (used + amount > toUnits(cap, 18)) {
      throw new PublicError(
        `this code has ${fromUnits(used >= toUnits(cap, 18) ? 0n : toUnits(cap, 18) - used, 18)} USD left`,
      );
    }
  }

  const result = await depositPrincipal(deps, {
    planId: plan.id,
    market: deps.venus,
    amountUsd: depositUsd,
  });
  switch (result.kind) {
    case 'simulated':
      return { status: 'simulated', approve: result.approve, deposit: result.deposit };
    case 'pending':
      // A pending deposit is finished from the chain. A pending approval means nothing was put in
      // yet: the judge is asked to run it again once it is mined, never told it is "confirming".
      return result.step === 'approve'
        ? { status: 'approval_pending', txHash: result.txHash }
        : { status: 'awaiting_tx', txHash: result.txHash };
    case 'failed':
      // The code is for the caller; the message (API and RPC text) is for the log.
      deps.log(`deposit: ${plan.id} failed — ${result.code}: ${result.message}`);
      throw new PublicError(`the deposit did not go through (${result.code})`);
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
      // The plan runs from now on — unless a stop, a guardian pause or a review hold came in
      // while the deposit was out: that one stands.
      const next = nextDue(plan.cadence, deps.now());
      const started = await updatePlanIf(
        deps.db,
        plan.id,
        { status: row.status, pausedReason: row.pausedReason },
        {
          status: 'active',
          pausedReason: null,
          ...(next.kind === 'due' ? { nextDueAt: next.nextDueAt } : {}),
        },
      );
      if (!started) deps.log(`deposit: ${plan.id} changed state meanwhile; left as it is`);
      return {
        status: 'deposited',
        depositedUsd: fromUnits(result.usdtSpent, 18),
        vTokens: result.vTokensMinted.toString(),
        txHashes: result.sent.map((s) => s.txHash),
      };
    }
  }
}
