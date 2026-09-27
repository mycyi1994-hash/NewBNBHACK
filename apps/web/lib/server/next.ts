/**
 * GET /api/plans/:id/next for skill plans (mode C, SPEC §8.2, §9): what the user's own wallet
 * should do now. decideCycle makes the decision from the worker's data (tape, Venus market) and
 * the user's on-chain position; the answer is `baw` commands as argv arrays — no calldata, no
 * signing on our side (DECISIONS D-03). Planning uses a tape estimate; the wallet quotes again,
 * and the answer says the least it may accept.
 */
import { BSC_USDT } from '@ijaro/chain';
import {
  decideCycle,
  formatShares,
  fromUnits,
  sharesFromTokens,
  toUnits,
  MAX_PRICE_IMPACT_PCT,
  type CycleInput,
  type Instrument,
  type Plan,
  type QuoteObservation,
  type Why,
} from '@ijaro/core';
import { estimateQuote, marketsFromTape, type TapeView } from './market';

/** A decision is good for five minutes; after that, ask again. */
export const NEXT_TTL_MS = 5 * 60_000;
export const SKILL_SLIPPAGE = '0.5';
const MAX_ROUNDS = 6;

export interface NextContext {
  plan: Plan;
  instruments: readonly Instrument[];
  tape: TapeView;
  caps: CycleInput['caps'];
  dailyRemainingUsd: string;
  dailyLimitUsd: string;
  /** Yield plans: the wallet's Venus position (on chain) and interest redeemed but unspent. */
  position?: { underlyingUsd: string; harvestedUnspentUsd: string };
  venus?: { investmentId: string };
  guardian: { blocked: false } | { blocked: true; rule: string };
  now: Date;
}

export interface NextStep {
  id: 'redeem' | 'quote' | 'swap';
  /** Show the user this preview and ask before running `run`. */
  preview?: string[];
  run: string[];
  /** For quote: stop unless data.toCoinAmount is at least this (human units). */
  acceptMinToCoinAmount?: string;
  /** For swap: poll this until FINISHED or FAILED — an orderId is not a trade. */
  confirm?: string[];
  /** For redeem and swap: report the transaction afterwards. */
  report?: { kind: 'redeem' | 'swap'; body: Record<string, string> };
}

export type NextAnswer =
  | {
      planId: string;
      decidedAt: string;
      decision: 'wait' | 'skip' | 'failed';
      /** The engine's reason (UX_COPY §4 key); absent when the data itself was missing. */
      why?: Why;
      /** Machine reason when there is no copy key yet (SPEC §11: "data unavailable" is human-owned). */
      reason?: string;
      retryAt?: string;
      data: { tape: TapeView['state']; sampledAt: string | null };
    }
  | {
      planId: string;
      decidedAt: string;
      expiresAt: string;
      decision: 'buy';
      spendUsd: string;
      interestUsd: string | null;
      instrument: Pick<Instrument, 'ticker' | 'issuer' | 'symbol' | 'address' | 'decimals'>;
      estimate: { source: 'tape'; sampledAt: string | null; tokens: string; shares: string };
      steps: NextStep[];
      data: { tape: TapeView['state']; sampledAt: string | null };
    };

const human = (units: bigint, decimals: number) => fromUnits(units, decimals);

export function nextFor(ctx: NextContext): NextAnswer {
  const decidedAt = ctx.now.toISOString();
  const data = { tape: ctx.tape.state, sampledAt: ctx.tape.sampledAt };
  const base = { planId: ctx.plan.id, decidedAt, data };
  // The plan's cadence: after a buy, the next one waits for its slot (the report moves it on).
  if (Date.parse(ctx.plan.nextDueAt) > ctx.now.getTime()) {
    return { ...base, decision: 'wait', reason: 'not_due', retryAt: ctx.plan.nextDueAt };
  }
  if (ctx.tape.state !== 'LIVE') {
    // Old or missing numbers: never guess; try again when the worker has fresh data.
    return {
      ...base,
      decision: 'wait',
      reason: ctx.tape.state === 'STALE' ? 'data_stale' : 'data_unavailable',
      retryAt: new Date(ctx.now.getTime() + NEXT_TTL_MS).toISOString(),
    };
  }
  const markets = marketsFromTape(ctx.instruments, ctx.tape.rows);
  const quotes: QuoteObservation[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const input: CycleInput = {
      now: ctx.now,
      plan: { ...ctx.plan, status: 'active', nextDueAt: decidedAt },
      caps: ctx.caps,
      dailyRemainingUsd: ctx.dailyRemainingUsd,
      dailyLimitUsd: ctx.dailyLimitUsd,
      markets,
      guardian: ctx.guardian,
      quotes,
      ...(ctx.position ? { position: ctx.position } : {}),
    };
    const decision = decideCycle(input);
    if (decision.kind === 'not_due') throw new Error('a decision asked for now cannot be not due');
    if (decision.kind === 'quote') {
      quotes.push(estimateQuote(ctx.tape.rows, decision.instrumentId, decision.spendUsd, ctx.now));
      continue;
    }
    if (decision.kind === 'done') {
      const { outcome } = decision;
      return {
        ...base,
        decision:
          outcome.kind === 'DEFERRED' ? 'wait' : outcome.kind === 'SKIPPED' ? 'skip' : 'failed',
        why: decision.why,
        ...(outcome.kind === 'DEFERRED' ? { retryAt: outcome.retryAt } : {}),
      };
    }
    const market = markets.find((m) => m.instrument.id === decision.instrumentId);
    if (!market)
      throw new Error(`decideCycle chose ${decision.instrumentId}, which is not in the tape`);
    const { instrument } = market;
    const tokens = BigInt(decision.quote.toTokenAmount ?? '0');
    if (tokens <= 0n) {
      // No estimate means no floor for the wallet's own quote: never buy without one.
      return {
        ...base,
        decision: 'wait',
        reason: 'data_unavailable',
        retryAt: new Date(ctx.now.getTime() + NEXT_TTL_MS).toISOString(),
      };
    }
    // The wallet's own quote may not come in more than the price-impact limit under the estimate.
    const minTokens = (tokens * BigInt(Math.round((100 - MAX_PRICE_IMPACT_PCT) * 100))) / 10_000n;
    const common = [
      '--fromToken',
      BSC_USDT,
      '--toToken',
      instrument.address,
      '--binanceChainId',
      '56',
    ];
    const steps: NextStep[] = [];
    if (toUnits(decision.redeemUsd, 18) > 0n && ctx.venus) {
      const args = [
        '--investmentId',
        ctx.venus.investmentId,
        '--tokenAddress',
        BSC_USDT,
        '--amount',
        decision.redeemUsd,
      ];
      steps.push({
        id: 'redeem',
        preview: ['baw', 'defi', 'preview', '--action', 'REDEEM', ...args, '--json'],
        run: ['baw', 'defi', 'redeem', ...args, '--json'],
        report: { kind: 'redeem', body: { kind: 'redeem', txHash: '<data.txHash>' } },
      });
    }
    steps.push({
      id: 'quote',
      run: [
        'baw',
        'market-order',
        'quote',
        '--fromTokenQty',
        decision.spendUsd,
        ...common,
        '--slippage',
        SKILL_SLIPPAGE,
        '--json',
      ],
      acceptMinToCoinAmount: human(minTokens, instrument.decimals),
    });
    steps.push({
      id: 'swap',
      run: [
        'baw',
        'market-order',
        'swap',
        '--fromTokenQty',
        decision.spendUsd,
        ...common,
        '--slippage',
        SKILL_SLIPPAGE,
        '--json',
      ],
      confirm: ['baw', 'market-order', 'list', '--orderId', '<data.orderId>', '--json'],
      report: {
        kind: 'swap',
        body: { kind: 'swap', txHash: '<txHash of the FINISHED order>', orderId: '<data.orderId>' },
      },
    });
    return {
      ...base,
      expiresAt: new Date(ctx.now.getTime() + NEXT_TTL_MS).toISOString(),
      decision: 'buy',
      spendUsd: decision.spendUsd,
      interestUsd: decision.interestUsd,
      instrument: {
        ticker: instrument.ticker,
        issuer: instrument.issuer,
        symbol: instrument.symbol,
        address: instrument.address,
        decimals: instrument.decimals,
      },
      estimate: {
        source: 'tape',
        sampledAt: ctx.tape.sampledAt,
        tokens: human(tokens, instrument.decimals),
        shares: formatShares(
          toUnits(sharesFromTokens(tokens, instrument.decimals, instrument.multiplier), 18),
        ),
      },
      steps,
    };
  }
  return { ...base, decision: 'failed', reason: 'too_many_rounds' };
}
