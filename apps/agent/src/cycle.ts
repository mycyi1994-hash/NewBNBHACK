/**
 * One plan cycle (SPEC §5): DUE → GUARDIAN → WINDOW → BUDGET → ASSET → PRICE → QUOTE → [REDEEM]
 * → APPROVE → SWAP → RECORD. decideCycle makes every decision; this module does the I/O between
 * its steps and writes down what happened: the cycle row and its step log, the cap reservation,
 * receipts, holdings, the plan's next due time, and an alert when a cycle FAILS.
 *
 * `simulate` runs every API call up to the simulations and signs nothing; `live` sends through the
 * house signer. A manual run (cycle:once) ignores the due time and a paused status and leaves the
 * schedule alone; a scheduled run moves it on (SPEC §5.9).
 */
import type { QuoteRoute } from '@ijaro/binance';
import type { Config } from '@ijaro/config';
import {
  boughtOutcome,
  decideCycle,
  fromUnits,
  guardianVerdict,
  nextDue,
  sharesFromTokens,
  toUnits,
  type CycleInput,
  type CycleOutcome,
  type ExecuteDecision,
  type Plan,
  type QuoteObservation,
  type Why,
} from '@ijaro/core';
import {
  acquirePlanLock,
  appendCycleStep,
  addToHolding,
  getPlan,
  openCycle,
  openGuardianActions,
  planFromRow,
  releasePlanLock,
  remainingSpend,
  reserveSpend,
  settleSpend,
  recordReceiptFacts,
  updateCycle,
  usdText,
  utcDay,
  type CycleRow,
  type PlanPatch,
  type PlanRow,
  type SpendCaps,
} from '@ijaro/db';
import { cycleAlert, type Alerter } from './alerts.js';
import { reconcileOutbox } from './executor/send.js';
import {
  ensureApproval,
  performSwap,
  type ApprovalResult,
  type SentTx,
  type TradeDeps,
} from './executor/trade.js';
import { redeemFromVenus, vTokensToUsd, type VenusMarket } from './executor/venus.js';
import { marketSnapshot, observeQuote } from './market.js';
import type { StockQuoteResult } from './stock-price.js';

/** The scheduler lock outlives the longest cycle (three receipt waits of three minutes). */
export const LOCK_TTL_MS = 12 * 60_000;
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
    maxPerTxUsd: judge ? sandbox : String(config.caps.houseMaxPerTxUsd),
    dailyLimitUsd: smaller(planDaily, globalDaily),
    spend,
  };
}

export async function recordReceipt(
  deps: CycleDeps,
  planId: string,
  cycleId: number | null,
  sent: SentTx,
) {
  await recordReceiptFacts(deps.db, planId, cycleId, {
    kind: sent.kind,
    txHash: sent.txHash,
    broadcastVia: sent.broadcastVia,
    blockNumber: sent.receipt.blockNumber,
    status: sent.receipt.status === 'success' ? 'success' : 'failed',
    simulatedAt: sent.simulatedAt,
    amounts: sent.amounts,
  });
}

export async function runCycle(
  deps: CycleDeps,
  planId: string,
  options: CycleOptions = {},
): Promise<CycleReport> {
  const now = deps.now();
  const row = await getPlan(deps.db, planId);
  if (!row) throw new Error(`plan ${planId} not found`);
  const plan = planFromRow(row);
  if (plan.status === 'stopped') return { status: 'stopped', planId };
  if (plan.owner.kind === 'skill') {
    throw new Error('skill plans are decided by /next and signed by their owner, not the house');
  }
  if (plan.expiresAt !== undefined && Date.parse(plan.expiresAt) <= now.getTime()) {
    // Judge plans stop after seven days (SPEC §8.2).
    await releasePlanLock(deps.db, planId, { status: 'stopped', pausedReason: 'expired' });
    return { status: 'stopped', planId };
  }
  if (!options.manual) {
    if (plan.status !== 'active') return { status: 'paused', planId };
    if (Date.parse(plan.nextDueAt) > now.getTime()) return { status: 'not_due', planId };
  }
  if (deps.mode === 'live') {
    // One signer for every plan: earlier transactions settle before a new cycle may sign.
    const outbox = await reconcileOutbox(deps, { from: deps.house });
    if (outbox.pending.length > 0)
      return { status: 'outbox_busy', planId, pending: outbox.pending };
  }
  if (!(await acquirePlanLock(deps.db, planId, now, LOCK_TTL_MS)))
    return { status: 'locked', planId };
  let patch: PlanPatch = {};
  try {
    return await cycleBody(deps, plan, row, options, (p) => {
      patch = { ...patch, ...p };
    });
  } finally {
    await releasePlanLock(deps.db, planId, patch);
  }
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
  if (!created && cycle.state !== 'running') return storedReport(cycle);
  const step = (entry: Record<string, unknown>) => appendCycleStep(deps.db, cycle.id, entry);
  const caps = planCaps(deps.config, plan);
  const scope = {
    planId: plan.id,
    ownerKind: row.ownerKind,
    ownerRef: row.ownerRef,
    day: utcDay(started),
    caps: caps.spend,
  };
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
    if (plan.mode === 'yield') {
      setPlan({ harvestedUnspentUsd: decimal(harvested), vtokenUnits: vTokens.toString() });
    }
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
  ) =>
    finish(
      { kind: 'FAILED', code: f.code, message: f.message, fundsMoved: f.fundsMoved },
      {
        key: f.fundsMoved === 'gas_only' ? 'why.failed.onchain' : 'why.failed.simulation',
        params: { code: f.code },
      },
      decision ? { decision } : {},
    );

  const awaiting = async (txHash: string, kind: string, decision: ExecuteDecision) => {
    await step({ step: 'AWAITING', kind, txHash, decision });
    await updateCycle(deps.db, cycle.id, {
      state: 'awaiting_tx',
      instrumentId: decision.instrumentId,
      spendUsd: decision.spendUsd,
    });
    if (plan.mode === 'yield') {
      setPlan({ harvestedUnspentUsd: decimal(harvested), vtokenUnits: vTokens.toString() });
    }
    deps.log(`cycle ${plan.id}#${cycle.id}: ${kind} ${txHash} not mined yet — awaiting`);
    return { status: 'awaiting_tx' as const, planId: plan.id, cycleId: cycle.id, txHash };
  };

  const tradeDeps: TradeDeps = deps;
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

    // EXECUTE
    const spend = units(decision.spendUsd);
    if (deps.mode === 'live' && !reserved) {
      const reservation = await reserveSpend(deps.db, {
        ...scope,
        cycleId: cycle.id,
        amountUsd: decision.spendUsd,
      });
      await step({ step: 'RESERVE', ...reservation, amountUsd: decision.spendUsd });
      if (!reservation.ok) {
        return finish(
          { kind: 'SKIPPED', reason: 'daily_cap', detail: reservation.reason },
          { key: 'why.skipped.daily_cap', params: { limit: caps.dailyLimitUsd } },
        );
      }
      reserved = true;
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
      await recordReceipt(deps, plan.id, cycle.id, redeem.sent);
      txHashes.push(redeem.sent.txHash);
      harvested += redeem.usdtReceived;
      vTokens -= redeem.vTokensBurned;
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
        await recordReceipt(deps, plan.id, cycle.id, swap.sent);
        txHashes.push(swap.sent.txHash);
        const spentUsd = swap.spentUnits > 0n ? decimal(swap.spentUnits) : decision.spendUsd;
        await settleSpend(deps.db, cycle.id, 'spent', spentUsd);
        await addToHolding(deps.db, plan.id, market.instrument, swap.receivedTokens, spentUsd);
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
          text: `[ijaro] ${plan.id} cycle #${cycle.id} needs review: ${swap.message}. The plan is paused.`,
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
