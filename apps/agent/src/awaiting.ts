/**
 * Finishing cycles that stopped at `awaiting_tx` (SPEC §5.8 v2): the runner gave up waiting for a
 * receipt, the outbox row stayed PENDING, and reconcileOutbox has settled it since. A confirmed
 * swap becomes BOUGHT from its receipt logs; an approval or redemption that confirmed while the
 * swap never followed ends FAILED with gas only (redeemed interest is kept as harvested); a
 * transaction that never went out ends FAILED with nothing moved.
 */
import { BSC_USDT, transferredFrom, transferredTo } from '@ijaro/chain';
import {
  boughtOutcome,
  fromUnits,
  nextDue,
  toUnits,
  type CycleOutcome,
  type ExecuteDecision,
  type Why,
} from '@ijaro/core';
import {
  cyclesAwaitingTx,
  getPlan,
  instrumentFromRow,
  listInstruments,
  planFromRow,
  settleSpend,
  txOutbox,
  updateCycle,
  updatePlan,
  usdText,
  type CycleRow,
  type PlanPatch,
} from '@ijaro/db';
import { eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { cycleAlert } from './alerts.js';
import { addToHolding, recordReceipt, type CycleDeps } from './cycle.js';

interface AwaitingStep {
  step: 'AWAITING';
  kind: 'approve' | 'swap' | 'redeem';
  txHash: Hex;
  decision: ExecuteDecision;
}

function awaitingStep(cycle: CycleRow): AwaitingStep | undefined {
  const steps = cycle.steps as { step?: string }[];
  return [...steps].reverse().find((s): s is AwaitingStep => s.step === 'AWAITING');
}

export async function completeAwaitingCycles(deps: CycleDeps): Promise<string[]> {
  const finished: string[] = [];
  for (const cycle of await cyclesAwaitingTx(deps.db)) {
    const pending = awaitingStep(cycle);
    if (!pending) continue; // held for review (anomaly): a human decides
    const [row] = await deps.db
      .select()
      .from(txOutbox)
      .where(eq(txOutbox.txHash, pending.txHash))
      .limit(1);
    if (!row || row.status === 'PENDING' || row.status === 'SIGNED') continue;
    const planRow = await getPlan(deps.db, cycle.planId);
    if (!planRow) continue;
    const plan = planFromRow(planRow);
    const at = deps.now();
    const patch: PlanPatch = {};
    let outcome: CycleOutcome;
    let why: Why;

    const receipt =
      row.status === 'CONFIRMED' ? await deps.chain.receipt(pending.txHash) : undefined;
    if (receipt && pending.kind === 'swap') {
      const instrumentRow = (await listInstruments(deps.db)).find(
        (i) => i.id === pending.decision.instrumentId,
      );
      if (!instrumentRow) throw new Error(`instrument ${pending.decision.instrumentId} is gone`);
      const instrument = instrumentFromRow(instrumentRow);
      const received = transferredTo(receipt.logs, instrument.address, deps.house);
      const spent = transferredFrom(receipt.logs, BSC_USDT, deps.house);
      await recordReceipt(deps, plan.id, cycle.id, {
        kind: 'swap',
        txHash: pending.txHash,
        broadcastVia: row.broadcastVia ?? 'unknown',
        receipt,
        simulatedAt: row.createdAt,
        amounts: {
          instrumentId: instrument.id,
          receivedTokens: received.toString(),
          spentUsdtUnits: spent.toString(),
        },
      });
      const spentUsd = spent > 0n ? fromUnits(spent, 18) : pending.decision.spendUsd;
      await settleSpend(deps.db, cycle.id, 'spent', spentUsd);
      await addToHolding(deps, plan.id, instrument, received, spentUsd);
      const bought = boughtOutcome(pending.decision, instrument, received.toString());
      outcome = bought.outcome;
      why = bought.why;
      if (pending.decision.interestUsd !== null) {
        const harvested = toUnits(usdText(planRow.harvestedUnspentUsd), 18);
        const used = toUnits(pending.decision.interestUsd, 18);
        patch.harvestedUnspentUsd = fromUnits(harvested > used ? harvested - used : 0n, 18);
      }
    } else if (receipt) {
      // The approval or redemption landed; the swap never followed. Gas was spent.
      await recordReceipt(deps, plan.id, cycle.id, {
        kind: pending.kind,
        txHash: pending.txHash,
        broadcastVia: row.broadcastVia ?? 'unknown',
        receipt,
        simulatedAt: row.createdAt,
        amounts: {},
      });
      if (pending.kind === 'redeem' && deps.venus) {
        const received = transferredTo(receipt.logs, BSC_USDT, deps.house);
        const burned = transferredFrom(receipt.logs, deps.venus.vToken, deps.house);
        patch.harvestedUnspentUsd = fromUnits(
          toUnits(usdText(planRow.harvestedUnspentUsd), 18) + received,
          18,
        );
        patch.vtokenUnits = (BigInt(planRow.vtokenUnits) - burned).toString();
      }
      await settleSpend(deps.db, cycle.id, 'released');
      outcome = {
        kind: 'FAILED',
        code: 'INTERRUPTED',
        message: `${pending.kind} confirmed after the cycle stopped waiting; no swap was sent`,
        fundsMoved: 'gas_only',
      };
      why = { key: 'why.failed.onchain', params: { code: 'INTERRUPTED' } };
    } else {
      // Reverted on chain, or never broadcast.
      await settleSpend(deps.db, cycle.id, 'released');
      const mined = row.broadcastVia !== null && row.error?.includes('reverted') === true;
      const code = mined
        ? `${pending.kind.toUpperCase()}_REVERTED`
        : `${pending.kind.toUpperCase()}_NOT_SENT`;
      outcome = {
        kind: 'FAILED',
        code,
        message: row.error ?? 'transaction failed',
        fundsMoved: mined ? 'gas_only' : 'none',
      };
      why = { key: mined ? 'why.failed.onchain' : 'why.failed.simulation', params: { code } };
    }

    await updateCycle(deps.db, cycle.id, {
      state: 'done',
      outcomeKind: outcome.kind,
      outcome,
      whyKey: why.key,
      whyParams: why.params,
      finishedAt: at.toISOString(),
    });
    const next = nextDue(plan.cadence, at);
    Object.assign(
      patch,
      next.kind === 'stop' ? { status: 'stopped' } : { nextDueAt: next.nextDueAt },
    );
    await updatePlan(deps.db, plan.id, patch);
    const alert = cycleAlert({
      planId: plan.id,
      cycleId: cycle.id,
      executionMode: cycle.executionMode,
      outcome,
    });
    if (alert) await deps.alerter?.send(alert);
    deps.log(`awaiting: ${plan.id}#${cycle.id} finished ${outcome.kind}`);
    finished.push(`${plan.id}#${cycle.id}`);
  }
  return finished;
}
