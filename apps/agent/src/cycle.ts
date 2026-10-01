/**
 * One plan cycle (SPEC §5): DUE → GUARDIAN → WINDOW → BUDGET → ASSET → PRICE → QUOTE → [REDEEM]
 * → APPROVE → SWAP → RECORD. decideCycle makes every decision; this module does the I/O between
 * its steps and writes down what happened: the cycle row and its step log, the cap reservation,
 * receipts, holdings, the plan's next due time, and an alert when a cycle FAILS.
 *
 * `simulate` runs every API call up to the simulations and signs nothing; `live` sends through the
 * house signer. A manual run (cycle:once) ignores the due time and a paused status and leaves the
 * schedule alone; a scheduled run moves it on (SPEC §5.9).
 *
 * Money columns are never written from this cycle's own snapshot: each confirmed redeem and swap
 * is applied the moment it is mined, with its receipt, in one transaction (packages/db record.ts).
 * A cycle that dies midway is recovered by the next holder of the plan's lock — handed to the
 * awaiting-cycle path when it signed something, closed with its reservation freed when it did not
 * — and a plan never starts a cycle while an earlier one is still out on chain (DECISIONS D-23).
 */
import type { QuoteRoute } from '@yieldvest/binance';
import type { Config } from '@yieldvest/config';
import {
  boughtOutcome,
  decideCycle,
  formatUsd,
  fromUnits,
  guardianVerdict,
  nextDue,
  RETRY_LATER_MS,
  sharesFromTokens,
  toUnits,
  type CycleInput,
  type CycleOutcome,
  type ExecuteDecision,
  type Plan,
  type QuoteObservation,
  type Why,
} from '@yieldvest/core';
import {
  acquirePlanLock,
  appendCycleStep,
  applyInterestRedeem,
  applySwap,
  cyclesOfPlan,
  getCycle,
  getPlan,
  openCycle,
  openGuardianActions,
  outboxOfCycle,
  planFromRow,
  releasePlanLock,
  remainingSpend,
  reserveSpend,
  settleSpend,
  recordReceiptFacts,
  unfinishedTransactions,
  updateCycle,
  updatePlan,
  usdText,
  utcDay,
  type CycleRow,
  type PlanPatch,
  type PlanRow,
  type ReceiptFacts,
  type SpendCaps,
} from '@yieldvest/db';
import { cycleAlert, type Alerter } from './alerts.js';
import { lastExecute } from './awaiting.js';
import {
  ensureApproval,
  performSwap,
  type ApprovalResult,
  type SentTx,
  type TradeDeps,
} from './executor/trade.js';
import { redeemFromVenus, vTokensToUsd, type VenusMarket } from './executor/venus.js';
import { redeemPlanPosition } from './guardian.js';
import { marketSnapshot, observeQuote } from './market.js';
import { LOCK_TTL_MS } from './plan-lock.js';
import { settleOutbox } from './settlement.js';
import type { StockQuoteResult } from './stock-price.js';

export { LOCK_TTL_MS };
/** Decide/act rounds per cycle before giving up (quotes, re-quotes, approval, redeem, swap). */
const MAX_ROUNDS = 12;

export interface CycleDeps extends TradeDeps {
  config: Config;
  alerter?: Alerter;
  stockQuote?: (contractAddress: string) => Promise<StockQuoteResult>;
  /** Venus USDT, needed by yield plans (discoverVenusUsdt at start-up). */
  venus?: VenusMarket;
}

export interface CycleOptions {
  /** cycle:once: run now even when not due or paused (never a stopped plan); keep the schedule. */
  manual?: boolean;
  /**
   * cycle:once --live: the buy a person confirmed after the dry run. The live run decides again from
   * fresh data; it may buy that instrument for at most that amount, and fails before it signs or
   * reserves anything if it would buy another one or spend more.
   */
  confirmed?: { instrumentId: string; maxSpendUsd: string };
}

export interface SimulatedBuy {
  instrumentId: string;
  spendUsd: string;
  /** Quote output, base units, and the shares it would be. */
  expectedTokens: string | null;
  expectedShares: string | null;
  approval: 'existing_allowance' | 'simulated';
  swapSimulation: { status: string; failReason: string };
  minReceive: string | null;
  redeem?: { status: string; failReason: string; vTokens: string };
}

export type CycleReport =
  | { status: 'not_due' | 'paused' | 'stopped' | 'locked'; planId: string }
  | { status: 'outbox_busy'; planId: string; pending: string[] }
  | {
      status: 'done';
      planId: string;
      cycleId: number;
      outcome: CycleOutcome;
      why: Why;
      txHashes: string[];
    }
  | { status: 'simulated'; planId: string; cycleId: number; buy: SimulatedBuy }
  | { status: 'awaiting_tx'; planId: string; cycleId: number; txHash: string }
  | { status: 'review'; planId: string; cycleId: number; message: string };

const units = (usd: string) => toUnits(usd, 18);
const decimal = (value: bigint) => fromUnits(value, 18);
const smaller = (a: string, b: string) => (units(a) <= units(b) ? a : b);

/** The caps that apply to a plan (CLAUDE.md rule 5): house caps, or the sandbox cap for judges. */
export function planCaps(config: Config, plan: Plan) {
  const judge = plan.owner.kind === 'judge';
  const sandbox = String(config.caps.sandboxMaxPerPlanUsd);
  const globalDaily = String(config.caps.dailySpendCapUsd);
  const planDaily = judge ? smaller(plan.limits.maxDailyUsd, sandbox) : plan.limits.maxDailyUsd;
  const spend: SpendCaps = {
    globalDailyUsd: globalDaily,
    planDailyUsd: planDaily,
    ...(judge ? { judgeTotalUsd: sandbox } : {}),
  };
  return {
    minBuyUsd: String(config.caps.minBuyUsd),
    // A judge plan is signed by the house wallet: the house per-transaction cap binds it too.
    maxPerTxUsd: judge
      ? smaller(sandbox, String(config.caps.houseMaxPerTxUsd))
      : String(config.caps.houseMaxPerTxUsd),
    dailyLimitUsd: smaller(planDaily, globalDaily),
    spend,
  };
}

/** SentTx → the facts its receipt row keeps. */
export function receiptFacts(sent: SentTx): ReceiptFacts {
  return {
    kind: sent.kind,
    txHash: sent.txHash,
    broadcastVia: sent.broadcastVia,
    blockNumber: sent.receipt.blockNumber,
    status: sent.receipt.status === 'success' ? 'success' : 'failed',
    simulatedAt: sent.simulatedAt,
    amounts: sent.amounts,
  };
}

/** A receipt with no effect on the plan's money (an approval, an anomaly held for review). */
export async function recordReceipt(
  deps: CycleDeps,
  planId: string,
  cycleId: number | null,
  sent: SentTx,
) {
  await recordReceiptFacts(deps.db, planId, cycleId, receiptFacts(sent));
}

export async function runCycle(
  deps: CycleDeps,
  planId: string,
  options: CycleOptions = {},
): Promise<CycleReport> {
  const now = deps.now();
  const first = await getPlan(deps.db, planId);
  if (!first) throw new Error(`plan ${planId} not found`);
  if (first.status === 'stopped') return { status: 'stopped', planId };
  if (first.ownerKind === 'skill') {
    throw new Error('skill plans are decided by /next and signed by their owner, not the house');
  }
  const expiresAt = first.expiresAt === null ? undefined : Date.parse(first.expiresAt);
  if (expiresAt !== undefined && !(expiresAt > now.getTime())) {
    // Judge plans stop after seven days (SPEC §8.2); a deposit goes back to the house wallet. A dry
    // run (a preview job, cycle:once without --live) never stops a plan that still holds a
    // position: only a live run can redeem it, and a stopped plan is never looked at again.
    const holds =
      first.mode === 'yield' &&
      (BigInt(first.vtokenUnits) > 1n ||
        (await unfinishedTransactions(deps.db, first.id)).length > 0);
    if (deps.mode === 'live' || !holds) {
      await redeemPlanPosition(deps, first, { status: 'stopped', reason: 'expired' });
    }
    return { status: 'stopped', planId };
  }
  if (!options.manual) {
    if (first.status !== 'active') return { status: 'paused', planId };
    if (!(Date.parse(planFromRow(first).nextDueAt) <= now.getTime()))
      return { status: 'not_due', planId };
  }
  if (deps.mode === 'live') {
    // One signer for every plan: earlier transactions settle — and their effects are applied —
    // before a new cycle may sign.
    const outbox = await settleOutbox(deps);
    if (outbox.pending.length > 0)
      return { status: 'outbox_busy', planId, pending: outbox.pending };
  }
  const locked = await acquirePlanLock(deps.db, planId, now, LOCK_TTL_MS);
  if (!locked) return { status: 'locked', planId };
  let patch: PlanPatch = {};
  try {
    // Holding the lock, a cycle of this plan still 'running' was left by a process that died.
    for (const dead of await cyclesOfPlan(deps.db, planId, ['running'])) {
      await recoverInterrupted(deps, dead);
    }
    // An earlier cycle still out on chain decides first: never read the plan around it.
    const out = await cyclesOfPlan(deps.db, planId, ['awaiting_tx']);
    if (out.length > 0) {
      return { status: 'outbox_busy', planId, pending: out.map((c) => awaitingHash(c)) };
    }
    // Decide from the row read under the lock, not the one read before it (recovery may have
    // moved the plan on, or paused it for review).
    const fresh = (await getPlan(deps.db, planId)) ?? locked;
    if (fresh.status === 'stopped') return { status: 'stopped', planId };
    if (!options.manual) {
      if (fresh.status !== 'active') return { status: 'paused', planId };
      if (!(Date.parse(fresh.nextDueAt) <= deps.now().getTime()))
        return { status: 'not_due', planId };
    }
    return await cycleBody(deps, planFromRow(fresh), fresh, options, (p) => {
      patch = { ...patch, ...p };
    });
  } finally {
    await releasePlanLock(deps.db, planId, locked.lockUntil, patch);
  }
}

const awaitingHash = (cycle: CycleRow) => {
  const steps = cycle.steps as { step?: string; txHash?: string }[];
  return [...steps].reverse().find((s) => s.step === 'AWAITING')?.txHash ?? `cycle#${cycle.id}`;
};

/**
 * A cycle left 'running' by a process that died (a crash, a restart, an exception mid-way). If it
 * signed anything, the awaiting-cycle path finishes it from the chain — applying what was mined,
 * once — so the same interest is never redeemed or spent twice. If it signed nothing, it ends
 * FAILED with its reservation freed.
 */
export async function recoverInterrupted(deps: CycleDeps, cycle: CycleRow): Promise<void> {
  const signed = await outboxOfCycle(deps.db, cycle.id);
  const latest = signed.at(-1);
  const decision = lastExecute(cycle);
  if (latest && decision) {
    await appendCycleStep(deps.db, cycle.id, {
      step: 'AWAITING',
      kind: latest.kind,
      txHash: latest.txHash,
      decision,
      recovered: true,
    });
    await updateCycle(deps.db, cycle.id, { state: 'awaiting_tx' });
    deps.log(`cycle ${cycle.planId}#${cycle.id}: interrupted after signing — finishing from chain`);
    return;
  }
  if (latest) {
    // Signed, but with no recorded decision: a human looks at it (the plan waits).
    await appendCycleStep(deps.db, cycle.id, {
      step: 'ANOMALY',
      message: 'interrupted, no decision',
    });
    await updateCycle(deps.db, cycle.id, { state: 'awaiting_tx' });
    await updatePlan(deps.db, cycle.planId, { status: 'paused', pausedReason: 'needs_review' });
    await deps.alerter?.send({
      key: `interrupted:${cycle.planId}:${cycle.id}`,
      text: `[yieldvest] ${cycle.planId} cycle #${cycle.id} was interrupted after signing with no recorded decision. The plan is paused; a human must check it.`,
    });
    return;
  }
  await settleSpend(deps.db, cycle.id, 'released');
  const outcome: CycleOutcome = {
    kind: 'FAILED',
    code: 'INTERRUPTED',
    message: 'the cycle stopped before signing anything',
    fundsMoved: 'none',
  };
  // The scheduled cycle for this due time is closed: the plan moves on to its next slot.
  const planRow = await getPlan(deps.db, cycle.planId);
  if (planRow && Date.parse(planRow.nextDueAt) === Date.parse(cycle.dueAt)) {
    const next = nextDue(planFromRow(planRow).cadence, deps.now());
    await updatePlan(
      deps.db,
      cycle.planId,
      next.kind === 'stop' ? { status: 'stopped' } : { nextDueAt: next.nextDueAt },
    );
  }
  await updateCycle(deps.db, cycle.id, {
    state: 'done',
    outcomeKind: outcome.kind,
    outcome,
    whyKey: 'why.failed.simulation',
    whyParams: { code: 'INTERRUPTED' },
    finishedAt: deps.now().toISOString(),
  });
  deps.log(`cycle ${cycle.planId}#${cycle.id}: interrupted before signing — closed`);
}

async function cycleBody(
  deps: CycleDeps,
  plan: Plan,
  row: PlanRow,
  options: CycleOptions,
  setPlan: (patch: PlanPatch) => void,
): Promise<CycleReport> {
  const started = deps.now();
  // A scheduled cycle is idempotent on (plan, due time); every manual request is a cycle of its
  // own, so a second one in the same millisecond moves one millisecond on.
  let dueAt = options.manual ? started.toISOString() : plan.nextDueAt;
  let opened = await openCycle(deps.db, { planId: plan.id, dueAt, executionMode: deps.mode });
  for (let bump = 1; options.manual && !opened.created && bump <= 10; bump++) {
    dueAt = new Date(started.getTime() + bump).toISOString();
    opened = await openCycle(deps.db, { planId: plan.id, dueAt, executionMode: deps.mode });
  }
  const { cycle, created } = opened;
  if (!created) {
    if (cycle.state === 'running') throw new Error(`cycle ${cycle.id} is still running`);
    // Already decided for this due time (a crash after it finished and before the plan moved
    // on): move the plan on from the stored outcome rather than stay due on it forever.
    if (!options.manual && cycle.state === 'done') {
      const stored = cycle.outcome as { kind?: string; retryAt?: string } | null;
      const next = nextDue(
        plan.cadence,
        deps.now(),
        stored?.kind === 'DEFERRED' ? stored.retryAt : undefined,
      );
      setPlan(next.kind === 'stop' ? { status: 'stopped' } : { nextDueAt: next.nextDueAt });
    }
    return storedReport(cycle);
  }
  const step = (entry: Record<string, unknown>) => appendCycleStep(deps.db, cycle.id, entry);
  const caps = planCaps(deps.config, plan);
  const scope = {
    planId: plan.id,
    ownerKind: row.ownerKind,
    ownerRef: row.ownerRef,
    day: utcDay(started),
    caps: caps.spend,
  };
  let reservedUnits: bigint | null = null;
  const dailyRemainingUsd = await remainingSpend(deps.db, scope);
  if (plan.target.type !== 'ticker') throw new Error('sector plans are not implemented');
  const snapshot = await marketSnapshot(deps, plan.target.ticker);
  await step({
    step: 'INPUTS',
    at: started.toISOString(),
    mode: deps.mode,
    dailyRemainingUsd: usdText(dailyRemainingUsd),
    markets: snapshot.markets.map((m) => ({
      id: m.instrument.id,
      status: m.status.reasonCode,
      onchainSharePriceUsd: m.onchainSharePriceUsd,
      independentSharePriceUsd: m.independentSharePriceUsd,
    })),
    unavailable: snapshot.unavailable,
  });

  let vTokens = BigInt(row.vtokenUnits);
  let harvested = units(usdText(row.harvestedUnspentUsd));
  const position = async () => {
    if (plan.mode !== 'yield') return undefined;
    if (!deps.venus) throw new Error('yield plans need the Venus market (discoverVenusUsdt)');
    return {
      underlyingUsd: await vTokensToUsd(deps.chain, deps.venus, vTokens),
      harvestedUnspentUsd: decimal(harvested),
    };
  };

  // Open guardian verdicts (PLAN §7): a pause_buys or redeem_all rule makes the cycle SKIPPED.
  const guardian = guardianVerdict(await openGuardianActions(deps.db, plan.id));
  if (guardian.blocked) await step({ step: 'GUARDIAN', rule: guardian.rule });

  const quotes: QuoteObservation[] = [];
  const routes = new Map<string, QuoteRoute>();
  const txHashes: string[] = [];
  let approval: Extract<ApprovalResult, { kind: 'ready' }> | undefined;
  let reserved = false;
  let redeemDone = false;
  let redeemReport: SimulatedBuy['redeem'];

  const finish = async (
    outcome: CycleOutcome,
    why: Why,
    extra: { decision?: ExecuteDecision } = {},
  ): Promise<CycleReport> => {
    const at = deps.now();
    await updateCycle(deps.db, cycle.id, {
      state: 'done',
      outcomeKind: outcome.kind,
      outcome,
      whyKey: why.key,
      whyParams: why.params,
      finishedAt: at.toISOString(),
      ...(extra.decision
        ? {
            instrumentId: extra.decision.instrumentId,
            spendUsd: extra.decision.spendUsd,
            interestUsd: extra.decision.interestUsd,
          }
        : {}),
      ...(outcome.kind === 'DEFERRED' ? { retryAt: outcome.retryAt } : {}),
    });
    if (reserved && outcome.kind !== 'BOUGHT') await settleSpend(deps.db, cycle.id, 'released');
    if (!options.manual) {
      const next = nextDue(
        plan.cadence,
        at,
        outcome.kind === 'DEFERRED' ? outcome.retryAt : undefined,
      );
      setPlan(next.kind === 'stop' ? { status: 'stopped' } : { nextDueAt: next.nextDueAt });
    }
    if (deps.mode === 'live' && deps.alerter) {
      const alert = cycleAlert({
        planId: plan.id,
        cycleId: cycle.id,
        executionMode: deps.mode,
        outcome,
      });
      if (alert) await deps.alerter.send(alert);
    }
    deps.log(`cycle ${plan.id}#${cycle.id}: ${outcome.kind} — ${why.key}`);
    return { status: 'done', planId: plan.id, cycleId: cycle.id, outcome, why, txHashes };
  };

  const failed = (
    f: { code: string; message: string; fundsMoved: 'none' | 'gas_only' },
    decision?: ExecuteDecision,
  ) => {
    // What this cycle already sent (an approval, a redeem) cost gas, whatever failed after it:
    // "no funds moved" would not be true.
    const fundsMoved = txHashes.length > 0 ? 'gas_only' : f.fundsMoved;
    return finish(
      { kind: 'FAILED', code: f.code, message: f.message, fundsMoved },
      {
        key: fundsMoved === 'gas_only' ? 'why.failed.onchain' : 'why.failed.simulation',
        params: { code: f.code },
      },
      decision ? { decision } : {},
    );
  };

  const awaiting = async (txHash: string, kind: string, decision: ExecuteDecision) => {
    await step({ step: 'AWAITING', kind, txHash, decision });
    await updateCycle(deps.db, cycle.id, {
      state: 'awaiting_tx',
      instrumentId: decision.instrumentId,
      spendUsd: decision.spendUsd,
    });
    deps.log(`cycle ${plan.id}#${cycle.id}: ${kind} ${txHash} not mined yet — awaiting`);
    return { status: 'awaiting_tx' as const, planId: plan.id, cycleId: cycle.id, txHash };
  };

  const tradeDeps: TradeDeps = deps;
  try {
    return await rounds();
  } catch (error) {
    // Never leave the cycle 'running': what it signed is finished from the chain, and if it
    // signed nothing its reservation is freed. The error still reaches the caller's log.
    const current = await getCycle(deps.db, cycle.id);
    if (current?.state === 'running') await recoverInterrupted(deps, current);
    throw error;
  }

  async function rounds(): Promise<CycleReport> {
    if (plan.mode === 'yield' && !deps.venus) {
      // The Venus market was not found at start-up (a DeFi API blip): the plan waits for it, like
      // any data that is not there — it does not lose its slot to a failure.
      await step({ step: 'VENUS', unavailable: 'the Venus market is not known yet' });
      return finish(
        {
          kind: 'DEFERRED',
          reason: 'data_unavailable',
          retryAt: new Date(deps.now().getTime() + RETRY_LATER_MS).toISOString(),
          detail: 'venus market unknown',
        },
        { key: 'why.data.unavailable', params: {} },
      );
    }
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const input: CycleInput = {
        now: deps.now(),
        // A manual run acts on a paused plan as if it were active and due when it started (the
        // cycle's key may sit a millisecond later).
        plan: {
          ...plan,
          status: 'active',
          nextDueAt: options.manual ? started.toISOString() : dueAt,
        },
        caps: { minBuyUsd: caps.minBuyUsd, maxPerTxUsd: caps.maxPerTxUsd },
        dailyRemainingUsd: usdText(dailyRemainingUsd),
        dailyLimitUsd: caps.dailyLimitUsd,
        markets: snapshot.markets,
        guardian,
        quotes,
      };
      const pos = await position();
      if (pos) input.position = pos;
      const decision = decideCycle(input);

      if (decision.kind === 'not_due')
        throw new Error('a cycle opened for its due time cannot be not due');
      if (decision.kind === 'done') {
        await step({ step: 'DECIDED', outcome: decision.outcome, why: decision.why });
        return finish(decision.outcome, decision.why);
      }
      const market = snapshot.markets.find((m) => m.instrument.id === decision.instrumentId);
      if (!market)
        throw new Error(`decideCycle chose ${decision.instrumentId}, which is not in the snapshot`);
      if (decision.kind === 'quote') {
        const { observation, route } = await observeQuote(
          { client: deps.client, house: deps.house, now: deps.now },
          market,
          decision.spendUsd,
        );
        quotes.push(observation);
        if (route && observation.quoteId) routes.set(observation.quoteId, route);
        await step({ step: 'QUOTE', ...observation });
        continue;
      }

      // EXECUTE — the decision is recorded before anything is signed, so a cycle interrupted
      // later can still be finished from the chain (recoverInterrupted).
      const spend = units(decision.spendUsd);
      const { confirmed } = options;
      if (
        confirmed &&
        (decision.instrumentId !== confirmed.instrumentId || spend > units(confirmed.maxSpendUsd))
      ) {
        return failed(
          {
            code: 'NOT_CONFIRMED',
            message:
              `the live decision (${decision.instrumentId}, $${decision.spendUsd}) is not the buy ` +
              `that was confirmed (${confirmed.instrumentId}, at most $${confirmed.maxSpendUsd})`,
            fundsMoved: 'none',
          },
          decision,
        );
      }
      await step({ step: 'EXECUTE', decision });
      if (deps.mode === 'live' && !reserved) {
        const reservation = await reserveSpend(deps.db, {
          ...scope,
          day: utcDay(deps.now()),
          cycleId: cycle.id,
          amountUsd: decision.spendUsd,
        });
        await step({ step: 'RESERVE', ...reservation, amountUsd: decision.spendUsd });
        if (!reservation.ok) {
          return finish(
            { kind: 'SKIPPED', reason: 'daily_cap', detail: reservation.reason },
            {
              key: 'why.skipped.daily_cap',
              params: { daily: formatUsd(units(caps.dailyLimitUsd)) },
            },
          );
        }
        reserved = true;
        reservedUnits = spend;
      }
      if (reservedUnits !== null && spend > reservedUnits) {
        // A later round may never spend more than was reserved (e.g. another issuer at full size).
        return failed(
          {
            code: 'SPEND_ABOVE_RESERVATION',
            message: `spend ${decision.spendUsd} is above the ${decimal(reservedUnits)} reserved`,
            fundsMoved: 'none',
          },
          decision,
        );
      }

      if (units(decision.redeemUsd) > 0n && !redeemDone) {
        if (!deps.venus) throw new Error('yield plans need the Venus market');
        const redeem = await redeemFromVenus(tradeDeps, {
          planId: plan.id,
          cycleId: cycle.id,
          market: deps.venus,
          amountUsd: decision.redeemUsd,
          planVTokens: vTokens,
        });
        redeemDone = true;
        if (redeem.kind === 'failed') return failed(redeem, decision);
        if (redeem.kind === 'pending') return awaiting(redeem.txHash, 'redeem', decision);
        if (redeem.kind === 'simulated') {
          redeemReport = { ...redeem.redeem, vTokens: redeem.vTokens.toString() };
          await step({
            step: 'REDEEM',
            simulated: true,
            redeemUsd: decision.redeemUsd,
            ...redeemReport,
          });
          continue;
        }
        // Applied the moment it is mined, with its receipt: a later failure cannot lose it.
        await applyInterestRedeem(deps.db, plan.id, cycle.id, receiptFacts(redeem.sent), {
          usdtReceived: redeem.usdtReceived,
          vTokensBurned: redeem.vTokensBurned,
        });
        txHashes.push(redeem.sent.txHash);
        harvested += redeem.usdtReceived;
        vTokens = vTokens > redeem.vTokensBurned ? vTokens - redeem.vTokensBurned : 0n;
        await step({
          step: 'REDEEM',
          txHash: redeem.sent.txHash,
          usdtReceived: redeem.usdtReceived.toString(),
        });
        continue;
      }

      if (!approval) {
        const approved = await ensureApproval(tradeDeps, {
          planId: plan.id,
          cycleId: cycle.id,
          amount: spend,
        });
        if (approved.kind === 'failed') return failed(approved, decision);
        if (approved.kind === 'pending') return awaiting(approved.txHash, 'approve', decision);
        approval = approved;
        if (approved.sent) {
          await recordReceipt(deps, plan.id, cycle.id, approved.sent);
          txHashes.push(approved.sent.txHash);
        }
        await step({
          step: 'APPROVE',
          via: approved.via,
          amount: spend.toString(),
          txHash: approved.sent?.txHash,
        });
        continue; // decide again: the quote may have aged while the approval confirmed
      }

      const route = decision.quote.quoteId ? routes.get(decision.quote.quoteId) : undefined;
      if (!route) throw new Error('the chosen quote has no route');
      const swap = await performSwap(tradeDeps, {
        planId: plan.id,
        cycleId: cycle.id,
        instrument: market.instrument,
        amount: spend,
        quote: decision.quote,
        route,
        spender: approval.spender,
      });
      switch (swap.kind) {
        case 'requote': {
          await step({ step: 'REQUOTE', reason: swap.reason });
          const index = quotes.lastIndexOf(decision.quote);
          if (index >= 0)
            quotes[index] = { ...decision.quote, receivedAt: new Date(0).toISOString() };
          continue;
        }
        case 'simulated': {
          const buy: SimulatedBuy = {
            instrumentId: decision.instrumentId,
            spendUsd: decision.spendUsd,
            expectedTokens: decision.quote.toTokenAmount ?? null,
            expectedShares: decision.quote.toTokenAmount
              ? sharesFromTokens(
                  BigInt(decision.quote.toTokenAmount),
                  market.instrument.decimals,
                  market.instrument.multiplier,
                )
              : null,
            approval: approval.via === 'existing_allowance' ? 'existing_allowance' : 'simulated',
            swapSimulation: {
              status: swap.simulation.status,
              failReason: swap.simulation.failReason,
            },
            minReceive: swap.minReceive,
            ...(redeemReport ? { redeem: redeemReport } : {}),
          };
          await step({ step: 'SIMULATED', ...buy });
          await updateCycle(deps.db, cycle.id, {
            state: 'done',
            outcome: { kind: 'SIMULATED', ...buy },
            instrumentId: decision.instrumentId,
            spendUsd: decision.spendUsd,
            finishedAt: deps.now().toISOString(),
          });
          if (!options.manual) {
            const next = nextDue(plan.cadence, deps.now());
            setPlan(next.kind === 'stop' ? { status: 'stopped' } : { nextDueAt: next.nextDueAt });
          }
          return { status: 'simulated', planId: plan.id, cycleId: cycle.id, buy };
        }
        case 'bought': {
          txHashes.push(swap.sent.txHash);
          const spentUsd = swap.spentUnits > 0n ? decimal(swap.spentUnits) : decision.spendUsd;
          await applySwap(deps.db, {
            planId: plan.id,
            cycleId: cycle.id,
            facts: receiptFacts(swap.sent),
            instrument: market.instrument,
            receivedTokens: swap.receivedTokens,
            spentUsd,
            interestUsd: decision.interestUsd,
          });
          if (decision.interestUsd !== null) {
            const used = units(decision.interestUsd);
            harvested = harvested > used ? harvested - used : 0n;
          }
          const bought = boughtOutcome(decision, market.instrument, swap.receivedTokens.toString());
          await step({
            step: 'BOUGHT',
            txHash: swap.sent.txHash,
            received: swap.receivedTokens.toString(),
          });
          return finish(bought.outcome, bought.why, { decision });
        }
        case 'pending':
          return awaiting(swap.txHash, 'swap', decision);
        case 'anomaly': {
          await recordReceipt(deps, plan.id, cycle.id, swap.sent);
          await step({ step: 'ANOMALY', message: swap.message, txHash: swap.sent.txHash });
          await updateCycle(deps.db, cycle.id, { state: 'awaiting_tx' });
          setPlan({ status: 'paused', pausedReason: 'needs_review' });
          await deps.alerter?.send({
            key: `anomaly:${plan.id}:${cycle.id}`,
            text: `[yieldvest] ${plan.id} cycle #${cycle.id} needs review: ${swap.message}. The plan is paused.`,
          });
          return { status: 'review', planId: plan.id, cycleId: cycle.id, message: swap.message };
        }
        case 'failed':
          return failed(swap, decision);
      }
    }
    return failed({
      code: 'TOO_MANY_ROUNDS',
      message: `no decision after ${MAX_ROUNDS} rounds`,
      fundsMoved: 'none',
    });
  }
}

/** A cycle already finished for this due time (idempotent re-run). */
function storedReport(cycle: CycleRow): CycleReport {
  if (cycle.state === 'awaiting_tx') {
    const steps = cycle.steps as { step?: string; txHash?: string }[];
    const txHash = [...steps].reverse().find((s) => s.step === 'AWAITING')?.txHash ?? '';
    return { status: 'awaiting_tx', planId: cycle.planId, cycleId: cycle.id, txHash };
  }
  const outcome = cycle.outcome as { kind?: string } | null;
  if (outcome?.kind === 'SIMULATED') {
    const { kind: _kind, ...buy } = outcome as SimulatedBuy & { kind: string };
    return { status: 'simulated', planId: cycle.planId, cycleId: cycle.id, buy };
  }
  return {
    status: 'done',
    planId: cycle.planId,
    cycleId: cycle.id,
    outcome: cycle.outcome as CycleOutcome,
    why: { key: cycle.whyKey as Why['key'], params: (cycle.whyParams ?? {}) as Why['params'] },
    txHashes: [],
  };
}
