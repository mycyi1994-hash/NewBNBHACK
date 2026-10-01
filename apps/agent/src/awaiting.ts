/**
 * Finishing what was sent and not yet written down (SPEC §5.8 v2, DECISIONS D-23):
 * - a cycle at `awaiting_tx` (the runner stopped waiting for a receipt, or died after signing) is
 *   finished once every transaction it signed has settled, each confirmed one applied from its
 *   receipt logs, once: a swap becomes BOUGHT; an approval or redemption whose swap never
 *   followed ends FAILED with gas only (redeemed interest is kept as harvested); a transaction
 *   that reverted or never went out ends FAILED;
 * - a deposit or redeem outside any cycle (a Judge Mode deposit, yield:deposit, a stop, the
 *   guardian, yield:redeem) mined after its command stopped waiting is applied the same way.
 * A receipt the node does not return yet, or a Venus market not known yet, waits for the next
 * tick: nothing is ever booked as "not sent" while it may have been mined.
 */
import { BSC_USDT, transferredFrom, transferredTo } from '@yieldvest/chain';
import {
  boughtOutcome,
  fromUnits,
  nextDue,
  type CycleOutcome,
  type ExecuteDecision,
  type Why,
} from '@yieldvest/core';
import {
  applyDeposit,
  applyInterestRedeem,
  applyPositionRedeem,
  applySwap,
  appendCycleStep,
  cyclesAwaitingTx,
  getCycle,
  getPlan,
  instrumentFromRow,
  isoTime,
  listInstruments,
  markOutbox,
  outboxOfCycle,
  planFromRow,
  recordReceiptFacts,
  settleSpend,
  unfinishedTransactions,
  updateCycle,
  updatePlan,
  updatePlanIf,
  type CycleRow,
  type OutboxRow,
  type ReceiptFacts,
} from '@yieldvest/db';
import type { Hex } from 'viem';
import { cycleAlert } from './alerts.js';
import type { CycleDeps } from './cycle.js';
import type { ReceiptLike } from './executor/chain-port.js';

interface AwaitingStep {
  step: 'AWAITING';
  kind: 'approve' | 'swap' | 'redeem';
  txHash: Hex;
  decision: ExecuteDecision;
}

/** The step a cycle waits on; none when a later ANOMALY holds it for a human. */
function awaitingStep(cycle: CycleRow): AwaitingStep | undefined {
  const steps = cycle.steps as { step?: string }[];
  const at = steps.map((s) => s.step).lastIndexOf('AWAITING');
  if (at < 0 || steps.slice(at).some((s) => s.step === 'ANOMALY')) return undefined;
  return steps[at] as AwaitingStep;
}

/** The last execute decision a cycle recorded before signing (cycle.ts writes it). */
export function lastExecute(cycle: CycleRow): ExecuteDecision | undefined {
  const steps = cycle.steps as { step?: string; decision?: ExecuteDecision }[];
  return [...steps].reverse().find((s) => s.step === 'EXECUTE')?.decision;
}

type Applied =
  { kind: 'applied' | 'already'; receivedTokens?: bigint } | { kind: 'wait'; reason: string };

/** Applies the effect of one CONFIRMED outbox row from its receipt logs, once. */
async function applyConfirmed(
  deps: CycleDeps,
  row: OutboxRow,
  receipt: ReceiptLike,
  decision: ExecuteDecision | undefined,
): Promise<Applied> {
  const facts = (amounts: Record<string, string>): ReceiptFacts => ({
    kind: row.kind as ReceiptFacts['kind'],
    txHash: row.txHash,
    broadcastVia: row.broadcastVia ?? 'unknown',
    blockNumber: receipt.blockNumber,
    status: 'success',
    simulatedAt: isoTime(row.createdAt),
    amounts,
  });
  const done = (fresh: boolean, receivedTokens?: bigint): Applied => ({
    kind: fresh ? 'applied' : 'already',
    ...(receivedTokens === undefined ? {} : { receivedTokens }),
  });
  switch (row.kind) {
    case 'approve':
      return done(await recordReceiptFacts(deps.db, row.planId, row.cycleId, facts({})));
    case 'deposit': {
      if (!deps.venus) return { kind: 'wait', reason: 'Venus market not known yet' };
      const vTokens = transferredTo(receipt.logs, deps.venus.vToken, deps.house);
      const usdt = transferredFrom(receipt.logs, BSC_USDT, deps.house);
      const amounts = { vTokensMinted: vTokens.toString(), usdtSpent: usdt.toString() };
      const fresh = await applyDeposit(deps.db, row.planId, facts(amounts), {
        vTokens,
        usdtSpent: usdt,
      });
      // A Judge Mode deposit that settled late starts its plan, as an on-time one does — unless
      // the plan was stopped or held in the meantime.
      const plan = fresh ? await getPlan(deps.db, row.planId) : undefined;
      if (plan?.ownerKind === 'judge' && vTokens > 0n) {
        const next = nextDue(planFromRow(plan).cadence, deps.now());
        await updatePlanIf(
          deps.db,
          plan.id,
          { status: 'paused', pausedReason: 'awaiting_run' },
          {
            status: 'active',
            pausedReason: null,
            ...(next.kind === 'due' ? { nextDueAt: next.nextDueAt } : {}),
          },
        );
      }
      return done(fresh);
    }
    case 'redeem': {
      if (!deps.venus) return { kind: 'wait', reason: 'Venus market not known yet' };
      const usdtReceived = transferredTo(receipt.logs, BSC_USDT, deps.house);
      const vTokensBurned = transferredFrom(receipt.logs, deps.venus.vToken, deps.house);
      const amounts = {
        usdtReceived: usdtReceived.toString(),
        vTokensBurned: vTokensBurned.toString(),
      };
      const redeemed = { usdtReceived, vTokensBurned };
      // Outside a cycle a redeem takes the whole position (a stop, the guardian, the operator);
      // inside one it takes interest.
      return done(
        row.cycleId === null
          ? await applyPositionRedeem(deps.db, row.planId, facts(amounts), redeemed)
          : await applyInterestRedeem(deps.db, row.planId, row.cycleId, facts(amounts), redeemed),
      );
    }
    case 'swap': {
      if (!decision) return { kind: 'wait', reason: 'no recorded decision for this swap' };
      const instrumentRow = (await listInstruments(deps.db)).find(
        (i) => i.id === decision.instrumentId,
      );
      if (!instrumentRow)
        return { kind: 'wait', reason: `instrument ${decision.instrumentId} is gone` };
      const instrument = instrumentFromRow(instrumentRow);
      const received = transferredTo(receipt.logs, instrument.address, deps.house);
      const spent = transferredFrom(receipt.logs, BSC_USDT, deps.house);
      const fresh = await applySwap(deps.db, {
        planId: row.planId,
        cycleId: row.cycleId,
        facts: facts({
          instrumentId: instrument.id,
          receivedTokens: received.toString(),
          spentUsdtUnits: spent.toString(),
        }),
        instrument,
        receivedTokens: received,
        spentUsd: spent > 0n ? fromUnits(spent, 18) : decision.spendUsd,
        interestUsd: decision.interestUsd,
      });
      return done(fresh, received);
    }
    default:
      return { kind: 'wait', reason: `unknown transaction kind ${row.kind}` };
  }
}

export async function completeAwaitingCycles(deps: CycleDeps): Promise<string[]> {
  const finished: string[] = [];
  cycles: for (const cycle of await cyclesAwaitingTx(deps.db)) {
    const pending = awaitingStep(cycle);
    if (!pending) continue; // held for review (anomaly): a human decides
    const signed = await outboxOfCycle(deps.db, cycle.id);
    if (signed.some((tx) => tx.status === 'SIGNED' || tx.status === 'PENDING')) continue;

    // Every confirmed transaction of the cycle, applied once from its receipt.
    const receipts = new Map<string, ReceiptLike>();
    let receivedTokens: bigint | undefined;
    for (const tx of signed) {
      if (tx.status !== 'CONFIRMED') continue;
      const receipt = await deps.chain.receipt(tx.txHash as Hex);
      if (!receipt) continue cycles; // the node lags: next tick
      const applied = await applyConfirmed(deps, tx, receipt, pending.decision);
      if (applied.kind === 'wait') {
        deps.log(`awaiting: ${cycle.planId}#${cycle.id} waits — ${applied.reason}`);
        continue cycles;
      }
      receipts.set(tx.txHash, receipt);
      if (tx.kind === 'swap') receivedTokens = applied.receivedTokens;
    }

    const last =
      signed.find((tx) => tx.txHash.toLowerCase() === pending.txHash.toLowerCase()) ??
      signed.at(-1);
    if (!last) continue;
    if (last.status === 'FAILED' && last.broadcastVia !== null) {
      // Marked failed earlier (a replaced nonce, a lost receipt): believe only the chain.
      const late = await deps.chain.receipt(last.txHash as Hex);
      if (late?.status === 'success') {
        await markOutbox(deps.db, last.txHash, { status: 'CONFIRMED' });
        continue; // applied on the next tick, like any confirmed transaction
      }
    }
    const planRow = await getPlan(deps.db, cycle.planId);
    if (!planRow) continue;
    const plan = planFromRow(planRow);
    const at = deps.now();
    let outcome: CycleOutcome;
    let why: Why;
    // A buy writes the columns a buy finished inside its cycle writes (activity totals sum them).
    let boughtColumns: Partial<{
      instrumentId: string;
      spendUsd: string;
      interestUsd: string | null;
    }> = {};

    if (last.status === 'CONFIRMED' && last.kind === 'swap') {
      const instrumentRow = (await listInstruments(deps.db)).find(
        (i) => i.id === pending.decision.instrumentId,
      );
      if (!instrumentRow || receivedTokens === undefined) continue;
      if (receivedTokens === 0n) {
        // Mined, USDT gone, no tokens in: a human looks before anything else runs.
        await appendCycleStep(deps.db, cycle.id, {
          step: 'ANOMALY',
          message: 'swap confirmed but no tokens arrived',
          txHash: last.txHash,
        });
        await updatePlan(deps.db, plan.id, { status: 'paused', pausedReason: 'needs_review' });
        await deps.alerter?.send({
          key: `anomaly:${plan.id}:${cycle.id}`,
          text: `[yieldvest] ${plan.id} cycle #${cycle.id} needs review: swap confirmed but no tokens arrived. The plan is paused.`,
        });
        continue;
      }
      const bought = boughtOutcome(
        pending.decision,
        instrumentFromRow(instrumentRow),
        receivedTokens.toString(),
      );
      outcome = bought.outcome;
      why = bought.why;
      boughtColumns = {
        instrumentId: pending.decision.instrumentId,
        spendUsd: pending.decision.spendUsd,
        interestUsd: pending.decision.interestUsd,
      };
    } else if (last.status === 'CONFIRMED') {
      // The approval or redemption landed; the swap never followed. Gas was spent.
      await settleSpend(deps.db, cycle.id, 'released');
      outcome = {
        kind: 'FAILED',
        code: 'INTERRUPTED',
        message: `${last.kind} confirmed after the cycle stopped waiting; no swap was sent`,
        fundsMoved: 'gas_only',
      };
      why = { key: 'why.failed.onchain', params: { code: 'INTERRUPTED' } };
    } else {
      // Reverted on chain, or never went out.
      await settleSpend(deps.db, cycle.id, 'released');
      const reverted = last.error?.includes('reverted') === true;
      const code = `${last.kind.toUpperCase()}_${reverted ? 'REVERTED' : 'NOT_SENT'}`;
      outcome = {
        kind: 'FAILED',
        code,
        message: reverted ? 'the transaction reverted on chain' : 'the transaction never went out',
        fundsMoved: reverted || receipts.size > 0 ? 'gas_only' : 'none',
      };
      why = {
        key: outcome.fundsMoved === 'gas_only' ? 'why.failed.onchain' : 'why.failed.simulation',
        params: { code },
      };
    }

    await updateCycle(deps.db, cycle.id, {
      state: 'done',
      outcomeKind: outcome.kind,
      outcome,
      whyKey: why.key,
      whyParams: why.params,
      finishedAt: at.toISOString(),
      ...boughtColumns,
    });
    // Only the scheduled cycle moves the schedule; a manual one (cycle:once, a web job) never does.
    if (Date.parse(planRow.nextDueAt) === Date.parse(cycle.dueAt)) {
      const next = nextDue(plan.cadence, at);
      await updatePlan(
        deps.db,
        plan.id,
        next.kind === 'stop' ? { status: 'stopped' } : { nextDueAt: next.nextDueAt },
      );
    }
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

/**
 * Confirmed transactions no cycle is waiting for and whose effect is not applied yet: deposits
 * and redeems sent outside a cycle, or a cycle's transaction when that cycle is already closed.
 */
export async function applyOrphanTransactions(deps: CycleDeps): Promise<string[]> {
  const applied: string[] = [];
  for (const row of await unfinishedTransactions(deps.db)) {
    if (row.status !== 'CONFIRMED') continue;
    let decision: ExecuteDecision | undefined;
    if (row.cycleId !== null) {
      const cycle = await getCycle(deps.db, row.cycleId);
      if (!cycle || cycle.state !== 'done') continue; // its own cycle finishes it
      decision = lastExecute(cycle);
    }
    const receipt = await deps.chain.receipt(row.txHash as Hex);
    if (!receipt) continue;
    const result = await applyConfirmed(deps, row, receipt, decision);
    if (result.kind === 'applied') {
      applied.push(row.txHash);
      deps.log(`settle: applied ${row.kind} ${row.txHash} to ${row.planId}`);
    }
  }
  return applied;
}
