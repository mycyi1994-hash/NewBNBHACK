/**
 * The guardian tick (PLAN §7, SPEC §6; TASKS M2-06). Every tick: sample the inputs (Venus flags
 * and utilisation on chain, Venus TVL from the DeFi API, the USDT price from the Market API),
 * evaluate the rules, record each firing once in guardian_events (resolved when the rule stops
 * firing and its data was read), alert, and carry out the actions:
 *   - pause_buys: runCycle reads the open verdict and skips with why.skipped.guardian;
 *   - stop_deposits: yield:deposit refuses new principal;
 *   - redeem_all: yield plans are paused and, in live mode only, their whole position is redeemed
 *     — only after the redeem simulation passes; otherwise a human is asked.
 */
import { BinanceApiError, getProtocolSummary, getTokenPrices } from '@ijaro/binance';
import { BSC_USDT } from '@ijaro/chain';
import {
  evaluateGuardian,
  fromUnits,
  unevaluatedRules,
  underlyingFromVTokens,
  USDT_PEG_FLOOR,
  type GuardianAction,
  type GuardianInputs,
  type GuardianRule,
} from '@ijaro/core';
import {
  applyPositionRedeem,
  belowSince,
  insertGuardianEvent,
  insertGuardianSample,
  isoTime,
  listGuardianEvents,
  listPlans,
  resolveGuardianEvents,
  sampleNear,
  updatePlan,
  type PlanRow,
} from '@ijaro/db';
import type { CycleDeps } from './cycle.js';
import { redeemFromVenus, type VenusMarket } from './executor/venus.js';

const DAY_MS = 86_400_000;

/** A positive plain decimal: a TVL or price of "", "0" or garbage is no reading at all. */
const usableAmount = (value: string) => /^\d+(\.\d+)?$/.test(value) && Number(value) > 0;
/** A TVL sample counts as "24 h ago" within ±2 h. */
const DAY_AGO_TOLERANCE_MS = 2 * 60 * 60_000;

export interface GuardianReport {
  actions: GuardianAction[];
  opened: GuardianRule[];
  resolved: string[];
  redeemed: string[];
  paused: string[];
  unavailable: string[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Which inputs each rule needs: a rule is only resolved when its data was read this tick. */
const NEEDS: Record<GuardianRule, keyof Omit<GuardianInputs, 'now'>> = {
  protocol_paused: 'venus',
  utilization_high: 'venus',
  tvl_drop: 'tvl',
  usdt_depeg: 'usdt',
};

async function readInputs(deps: CycleDeps, unavailable: string[]): Promise<GuardianInputs> {
  const now = deps.now();
  const ts = now.toISOString();
  const inputs: GuardianInputs = { now };
  if (deps.venus) {
    try {
      const venus = await deps.chain.venusMarketState(deps.venus.vToken);
      inputs.venus = venus;
      await insertGuardianSample(deps.db, {
        ts,
        metric: 'venus_utilization_bps',
        value: String(venus.utilizationBps),
        source: 'chain',
      });
    } catch (error) {
      unavailable.push(`venus market: ${message(error)}`);
    }
  }
  try {
    const { tvl, securityScore } = await getProtocolSummary(deps.client, 'venus');
    // Shown with the risk disclosure (UX_COPY §5 {score}); not a guardian rule.
    if (securityScore !== null && /^\d+(\.\d+)?$/.test(securityScore)) {
      await insertGuardianSample(deps.db, {
        ts,
        metric: 'venus_security_score',
        value: securityScore,
        source: 'defi-data',
      });
    }
    if (tvl !== null && usableAmount(tvl)) {
      await insertGuardianSample(deps.db, {
        ts,
        metric: 'venus_tvl_usd',
        value: tvl,
        source: 'defi-data',
      });
      const dayAgo = await sampleNear(
        deps.db,
        'venus_tvl_usd',
        'defi-data',
        new Date(now.getTime() - DAY_MS),
        DAY_AGO_TOLERANCE_MS,
      );
      inputs.tvl = { nowUsd: Number(tvl), dayAgoUsd: dayAgo ? Number(dayAgo.value) : null };
    } else {
      unavailable.push(
        `venus tvl: ${tvl === null ? 'missing in protocol detail' : 'not a positive amount'}`,
      );
    }
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    unavailable.push(`venus tvl: ${error.code ?? error.kind} ${error.msg}`);
  }
  try {
    const [usdt] = await getTokenPrices(deps.client, [BSC_USDT]);
    if (usdt?.price && usableAmount(usdt.price)) {
      await insertGuardianSample(deps.db, {
        ts,
        metric: 'usdt_price_usd',
        value: usdt.price,
        source: 'market',
      });
      const since = await belowSince(deps.db, 'usdt_price_usd', 'market', String(USDT_PEG_FLOOR));
      inputs.usdt = { priceUsd: Number(usdt.price), belowPegSince: since ? isoTime(since) : null };
    } else {
      unavailable.push(`usdt price: ${usdt?.price ? 'not a positive amount' : 'missing'}`);
    }
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    unavailable.push(`usdt price: ${error.code ?? error.kind} ${error.msg}`);
  }
  return inputs;
}

/**
 * Takes one yield plan's whole Venus position out (live mode only, and only after the redeem
 * simulation passes) and sets its status. Without live mode or on failure the plan is still
 * paused or stopped, and a failure is alerted: a human decides what happens to the position.
 */
export async function redeemPlanPosition(
  deps: CycleDeps,
  plan: PlanRow,
  outcome: { status: 'paused' | 'stopped'; reason: string },
): Promise<'redeemed' | 'nothing_to_redeem' | 'users_wallet' | 'not_live' | 'failed'> {
  // Only house and judge plans hold a position in the house wallet. A skill plan's principal sits
  // in the user's own wallet (its vtoken_units come from the user's reports): the worker never
  // redeems it — that would take house funds — the user does, through the skill.
  if (plan.ownerKind === 'skill') {
    await updatePlan(deps.db, plan.id, { status: outcome.status, pausedReason: outcome.reason });
    return 'users_wallet';
  }
  const vTokens = BigInt(plan.vtokenUnits);
  if (plan.mode !== 'yield' || vTokens <= 1n) {
    await updatePlan(deps.db, plan.id, { status: outcome.status, pausedReason: outcome.reason });
    return 'nothing_to_redeem';
  }
  if (deps.mode !== 'live' || !deps.venus) {
    await updatePlan(deps.db, plan.id, { status: outcome.status, pausedReason: outcome.reason });
    return 'not_live';
  }
  const amountUsd = await wholePositionUsd(deps, deps.venus, vTokens);
  const result = await redeemFromVenus(deps, {
    planId: plan.id,
    cycleId: null,
    market: deps.venus,
    amountUsd,
    planVTokens: vTokens,
  });
  if (result.kind !== 'redeemed') {
    await updatePlan(deps.db, plan.id, {
      status: outcome.status,
      pausedReason: `${outcome.reason}:redeem_${result.kind}`,
    });
    await deps.alerter?.send({
      key: `redeem-all:${plan.id}`,
      text:
        `[ijaro] ${outcome.reason}: redeeming ${plan.id} did not complete (${result.kind}` +
        `${'code' in result ? ` ${result.code}` : ''}). The plan is ${outcome.status}; a human must decide.`,
    });
    return 'failed';
  }
  await applyPositionRedeem(
    deps.db,
    plan.id,
    {
      kind: 'redeem',
      txHash: result.sent.txHash,
      broadcastVia: result.sent.broadcastVia,
      blockNumber: result.sent.receipt.blockNumber,
      status: 'success',
      simulatedAt: result.sent.simulatedAt,
      amounts: { ...result.sent.amounts, reason: outcome.reason },
    },
    result,
    { status: outcome.status, pausedReason: outcome.reason },
  );
  return 'redeemed';
}

/**
 * What redeeming a plan's whole position asks for, in USDT: all its vTokens but one, so the API's
 * rounding can never ask for more than the plan holds.
 */
export async function wholePositionUsd(
  deps: Pick<CycleDeps, 'chain'>,
  market: VenusMarket,
  vTokens: bigint,
): Promise<string> {
  const rate = await deps.chain.exchangeRate(market.vToken);
  return fromUnits(underlyingFromVTokens(vTokens - 1n, rate), 18);
}

/** Pauses every yield plan with a Venus position and, in live mode, redeems it all. */
async function redeemAll(deps: CycleDeps, action: GuardianAction, report: GuardianReport) {
  const plans = (await listPlans(deps.db)).filter(
    (p) => p.mode === 'yield' && p.status !== 'stopped' && BigInt(p.vtokenUnits) > 0n,
  );
  for (const plan of plans) {
    if (!report.paused.includes(plan.id)) report.paused.push(plan.id);
    const done = await redeemPlanPosition(deps, plan, {
      status: 'paused',
      reason: `guardian:${action.rule}`,
    });
    if (done === 'redeemed') report.redeemed.push(plan.id);
  }
}

export async function guardianTick(deps: CycleDeps): Promise<GuardianReport> {
  const report: GuardianReport = {
    actions: [],
    opened: [],
    resolved: [],
    redeemed: [],
    paused: [],
    unavailable: [],
  };
  const inputs = await readInputs(deps, report.unavailable);
  report.actions = evaluateGuardian(inputs);

  const open = (await listGuardianEvents(deps.db, { openOnly: true, limit: 500 })).filter(
    (event) => event.planId === null && event.rule in NEEDS,
  );
  const firing = new Set(report.actions.map((a) => a.rule));
  // Only a rule that was evaluated this tick and is quiet may close: missing data is not calm.
  const unevaluated = new Set<string>(unevaluatedRules(inputs));
  for (const rule of new Set(open.map((event) => event.rule))) {
    if (!firing.has(rule as GuardianRule) && !unevaluated.has(rule)) {
      await resolveGuardianEvents(deps.db, rule, inputs.now);
      report.resolved.push(rule);
    }
  }
  const openRules = new Set(open.map((event) => event.rule));
  for (const action of report.actions) {
    if (!openRules.has(action.rule)) {
      await insertGuardianEvent(deps.db, {
        rule: action.rule,
        action: action.action,
        detail: action.detail,
        planId: null,
      });
      report.opened.push(action.rule);
      await deps.alerter?.send({
        key: `guardian:${action.rule}`,
        text: `[ijaro] guardian ${action.rule} → ${action.action} ${JSON.stringify(action.detail)}`,
      });
    }
    if (action.action === 'redeem_all') await redeemAll(deps, action, report);
  }
  if (report.opened.length + report.resolved.length > 0 || report.unavailable.length > 0) {
    deps.log(
      `guardian: opened [${report.opened.join(', ')}] resolved [${report.resolved.join(', ')}]` +
        (report.unavailable.length ? ` unavailable: ${report.unavailable.join('; ')}` : ''),
    );
  }
  return report;
}
