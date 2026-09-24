/**
 * decideCycle (SPEC §5.1–§5.6, TASKS M1-02): one pure step of a plan cycle. The agent calls it,
 * performs the one piece of I/O it asks for (a Trading API quote), appends the result to
 * `quotes` and calls it again, until the answer is a terminal outcome or `execute`. Nothing here
 * reads the network, the clock or the database, so every branch is a unit test.
 *
 * Order: DUE → GUARDIAN → WINDOW → BUDGET → ASSET → PRICE → QUOTE.
 */
import { fromUnits, interestUnits, toUnits } from './amounts.js';
import { sharesFromTokens } from './holdings.js';
import { nextRegularOpen, usSession } from './session.js';
import type { CycleOutcome, Instrument, Plan } from './types.js';
import { formatPct, formatShares, formatUsd, type Why, type WhyKey } from './why.js';

/** quoteId lives 30 s (DECISIONS Q-04); anything older than this is re-quoted before signing. */
export const MAX_QUOTE_AGE_MS = 25_000;
/** Above this price impact the spend is halved and re-quoted (SPEC §5.6). */
export const MAX_PRICE_IMPACT_PCT = 1;
export const MAX_REQUOTES = 2;
/** On-chain premium over an independent stock price that defers a regular-session buy (§5.5). */
export const MAX_PRICE_GAP_PCT = 2;
/** First quotes after the bell are noisy; retry two minutes after the open (§5.2). */
export const OPEN_SETTLE_MS = 2 * 60_000;
export const RETRY_LATER_MS = 30 * 60_000;

/** RWA statusInfo reason codes (official skill binance-tokenized-securities-info, Reason Codes). */
const CORPORATE_ACTION_CODES = new Set(['ASSET_PAUSED', 'ASSET_LIMITED']);
const SESSION_CLOSED_CODES = new Set(['MARKET_CLOSED', 'MARKET_PAUSED', 'MARKET_MAINTENANCE']);
/** Trading API codes: bStock / Ondo RFQ rejected outside the session; no liquidity; Ondo minimum. */
const OFF_HOURS_QUOTE_CODES = new Set(['40369', '40367']);
const NO_LIQUIDITY_CODE = '40374';
const VENUE_MINIMUM_CODE = '40375';

/** RWA statusInfo of one token. The agent fails the cycle itself when the status call fails. */
export interface TokenStatus {
  openState: boolean | null;
  reasonCode: string | null;
  reasonMsg: string | null;
  /** Unix ms, when the API gives one. */
  nextOpenTime: number | null;
}

export interface InstrumentMarket {
  instrument: Instrument;
  status: TokenStatus;
  /** On-chain price per underlying share (token price ÷ multiplier), USD. */
  onchainSharePriceUsd: string | null;
  /**
   * An independent US stock price (RWA Dynamic V2 `stockInfo.price`); null off-hours or when
   * unknown. The RWA `referencePrice` does not qualify: it is derived from the token (Q-06).
   */
  independentSharePriceUsd: string | null;
  /** Smallest order the venue accepts, USD (Ondo rejects 5.00 and accepts 5.01, Q-03). */
  venueMinUsd: string | null;
}

export interface QuoteObservation {
  instrumentId: string;
  spendUsd: string;
  /** When the quote response arrived (ISO). */
  receivedAt: string;
  quoteId?: string;
  /** Tokens out, base units. */
  toTokenAmount?: string;
  /** Percent as a decimal string, e.g. "0.0149". */
  priceImpactPct?: string;
  executionMode?: string;
  /** Trading API code when the quote failed. */
  errorCode?: string;
  errorMsg?: string;
}

export interface CycleInput {
  now: Date;
  plan: Plan;
  caps: {
    /** The minimum-buy cap (config `caps.minBuyUsd`). */
    minBuyUsd: string;
    /** Per-transaction cap from config: the house cap for house plans, the sandbox cap for judges. */
    maxPerTxUsd: string;
  };
  /** What this plan may still spend today (UTC): the tighter of its own and the global cap. */
  dailyRemainingUsd: string;
  /** The daily limit named in the copy when it is reached. */
  dailyLimitUsd: string;
  /** Registry rows for the plan's ticker that the RWA list returned this tick. */
  markets: readonly InstrumentMarket[];
  /** Yield plans: the Venus position and interest already redeemed but not yet spent. */
  position?: { underlyingUsd: string; harvestedUnspentUsd: string };
  guardian?: { blocked: false } | { blocked: true; rule: string };
  /** Quotes fetched so far in this cycle, oldest first. */
  quotes?: readonly QuoteObservation[];
}

export type TerminalOutcome = Exclude<CycleOutcome, { kind: 'BOUGHT' }>;

export interface ExecuteDecision {
  kind: 'execute';
  instrumentId: string;
  spendUsd: string;
  quote: QuoteObservation;
  /** USD to redeem from Venus before the swap; never more than the interest in the position. */
  redeemUsd: string;
  /** Part of the spend paid from interest; null for safe plans. */
  interestUsd: string | null;
  /** An `anytime` plan buying outside the regular session. */
  offHours: boolean;
  refGapPct: string | null;
}

export type Decision =
  | { kind: 'not_due' }
  | { kind: 'done'; outcome: TerminalOutcome; why: Why }
  | { kind: 'quote'; instrumentId: string; spendUsd: string }
  | ExecuteDecision;

const units = (usd: string) => toUnits(usd, 18);
const decimal = (value: bigint) => fromUnits(value, 18);
const smallest = (first: bigint, ...rest: bigint[]) =>
  rest.reduce((a, b) => (b < a ? b : a), first);
const iso = (ms: number) => new Date(ms).toISOString();

function done(outcome: TerminalOutcome, key: WhyKey, params: Record<string, string>): Decision {
  return { kind: 'done', outcome, why: { key, params } };
}

function marketClosed(retryAtMs: number, detail?: string): Decision {
  const retryAt = iso(retryAtMs);
  return done(
    { kind: 'DEFERRED', reason: 'market_closed', retryAt, ...(detail ? { detail } : {}) },
    'why.deferred.market_closed',
    { open: retryAt },
  );
}

/**
 * UX_COPY §4 has keys for earnings, dividends and splits only. A stock dividend reads correctly
 * under the dividend line; other actions (merger, spinoff, maintenance, …) fall back to the
 * "can't buy it right now" line until copy for them exists, with the real reason in `detail`.
 */
function corporateActionWhy(status: TokenStatus): WhyKey {
  const action = status.reasonMsg ?? '';
  if (status.reasonCode === 'ASSET_LIMITED' && action === 'earnings') {
    return 'why.skipped.corporate_action.earnings';
  }
  if (action === 'cash_dividend' || action === 'stock_dividend') {
    return 'why.skipped.corporate_action.cash_dividend';
  }
  if (action === 'stock_split') return 'why.skipped.corporate_action.stock_split';
  return 'why.skipped.no_liquidity';
}

/** Quote results that rule an instrument out for this cycle, so the next issuer is tried. */
function exclusionOf(quote: QuoteObservation): string | undefined {
  if (quote.errorCode === NO_LIQUIDITY_CODE) return 'no_liquidity';
  if (quote.errorCode === VENUE_MINIMUM_CODE) return 'venue_minimum';
  // RFQ orders are signed EIP-712 messages that the Transaction API cannot simulate; they stay
  // off until a human approves that spending path (DECISIONS Q-15).
  if (!quote.errorCode && quote.executionMode === 'RFQ') return 'rfq_not_enabled';
  return undefined;
}

export function decideCycle(input: CycleInput): Decision {
  const { now, plan } = input;
  const nowMs = now.getTime();

  // DUE
  if (plan.status !== 'active') return { kind: 'not_due' };
  if (plan.expiresAt !== undefined && Date.parse(plan.expiresAt) <= nowMs) {
    return { kind: 'not_due' };
  }
  if (Date.parse(plan.nextDueAt) > nowMs) return { kind: 'not_due' };
  if (plan.target.type !== 'ticker') {
    throw new Error(`plan ${plan.id}: sector targets are not implemented`);
  }
  const ticker = plan.target.ticker;

  // GUARDIAN — rules live in guardian.ts (M2-06); the engine only honours the verdict.
  if (input.guardian?.blocked) {
    const { rule } = input.guardian;
    return done({ kind: 'SKIPPED', reason: 'guardian', detail: rule }, 'why.skipped.guardian', {
      rule,
    });
  }

  // WINDOW — our NYSE calendar is the gate (bStocks report TRADING overnight).
  const regular = usSession(now) === 'regular';
  if (plan.window === 'regular_session' && !regular) {
    return marketClosed(nextRegularOpen(now).getTime() + OPEN_SETTLE_MS);
  }
  const offHours = !regular;

  // BUDGET
  const minBuy = units(input.caps.minBuyUsd);
  let maxPerBuy = smallest(units(plan.limits.maxPerBuyUsd), units(input.caps.maxPerTxUsd));
  if (offHours) maxPerBuy /= 2n;
  if (maxPerBuy < minBuy) {
    throw new Error(
      `plan ${plan.id}: per-buy limit ${decimal(maxPerBuy)} is below the minimum buy ${decimal(minBuy)}`,
    );
  }
  let interestInPosition = 0n;
  let harvestedUnspent = 0n;
  if (plan.mode === 'yield') {
    if (!input.position) throw new Error(`plan ${plan.id}: yield cycle without a position`);
    // Never negative: a position under principal has no interest to spend.
    interestInPosition = interestUnits(
      units(input.position.underlyingUsd),
      units(plan.principalUsd),
      0n,
    );
    harvestedUnspent = units(input.position.harvestedUnspentUsd);
  }
  const interestAvailable = interestInPosition + harvestedUnspent;
  const budget = interestAvailable + units(plan.contributionUsd);
  if (budget < minBuy) {
    return done(
      { kind: 'SKIPPED', reason: 'below_min', detail: `budget ${decimal(budget)}` },
      'why.skipped.below_min',
      { acc: formatUsd(budget), min: formatUsd(minBuy) },
    );
  }
  const dailyRemaining = units(input.dailyRemainingUsd);
  if (dailyRemaining < minBuy) {
    return done({ kind: 'SKIPPED', reason: 'daily_cap' }, 'why.skipped.daily_cap', {
      daily: formatUsd(units(input.dailyLimitUsd)),
    });
  }
  const plannedSpend = smallest(budget, maxPerBuy, dailyRemaining);

  // ASSET — issuer preference order; quote failures rule an issuer out for this cycle.
  const quotes = input.quotes ?? [];
  const excluded = new Map<string, string>();
  for (const quote of quotes) {
    const reason = exclusionOf(quote);
    if (reason) excluded.set(quote.instrumentId, reason);
  }
  const candidates = plan.issuerPreference
    .map((issuer) =>
      input.markets.find((m) => m.instrument.ticker === ticker && m.instrument.issuer === issuer),
    )
    .filter((m): m is InstrumentMarket => m !== undefined);

  let chosen: InstrumentMarket | undefined;
  let sessionClosed: { code: string; nextOpenTime: number | null } | undefined;
  let venueMinimum: bigint | undefined;
  const notes: string[] = [];
  for (const market of candidates) {
    const { instrument, status } = market;
    const exclusion = excluded.get(instrument.id);
    if (exclusion) {
      notes.push(`${instrument.id}:${exclusion}`);
      continue;
    }
    if (status.openState !== true || status.reasonCode !== 'TRADING') {
      const code = status.reasonCode ?? 'UNKNOWN';
      // A corporate action concerns the stock, not the venue: skip rather than switch issuer.
      if (CORPORATE_ACTION_CODES.has(code)) {
        return done(
          {
            kind: 'SKIPPED',
            reason: 'corporate_action',
            detail: `${code}:${status.reasonMsg ?? ''}`,
          },
          corporateActionWhy(status),
          { ticker },
        );
      }
      if (SESSION_CLOSED_CODES.has(code)) {
        sessionClosed ??= { code, nextOpenTime: status.nextOpenTime };
      }
      notes.push(`${instrument.id}:${code}`);
      continue;
    }
    if (market.venueMinUsd !== null && plannedSpend < units(market.venueMinUsd)) {
      const venueMin = units(market.venueMinUsd);
      venueMinimum = venueMinimum === undefined ? venueMin : smallest(venueMinimum, venueMin);
      notes.push(`${instrument.id}:venue_minimum`);
      continue;
    }
    chosen = market;
    break;
  }

  if (!chosen) {
    if (sessionClosed) {
      const next = sessionClosed.nextOpenTime;
      const retryAtMs =
        next !== null && next > nowMs ? next + OPEN_SETTLE_MS : nowMs + RETRY_LATER_MS;
      return marketClosed(retryAtMs, sessionClosed.code);
    }
    if (venueMinimum !== undefined) {
      return done(
        { kind: 'SKIPPED', reason: 'below_min', detail: 'venue_minimum' },
        'why.skipped.below_min',
        { acc: formatUsd(plannedSpend), min: formatUsd(venueMinimum) },
      );
    }
    return done(
      {
        kind: 'SKIPPED',
        reason: 'no_instrument',
        detail: notes.length > 0 ? notes.join(', ') : 'no registered instrument',
      },
      'why.skipped.no_liquidity',
      { ticker },
    );
  }

  // PRICE — only an independent stock price can show a premium.
  let refGapPct: string | null = null;
  if (chosen.independentSharePriceUsd !== null && chosen.onchainSharePriceUsd !== null) {
    const gap =
      (Number(chosen.onchainSharePriceUsd) / Number(chosen.independentSharePriceUsd) - 1) * 100;
    refGapPct = formatPct(gap);
    if (regular && gap > MAX_PRICE_GAP_PCT) {
      return done(
        { kind: 'DEFERRED', reason: 'price_gap', retryAt: iso(nowMs + RETRY_LATER_MS) },
        'why.deferred.price_gap',
        { gap: refGapPct },
      );
    }
  }

  // QUOTE
  const instrumentId = chosen.instrument.id;
  const own = quotes.filter((q) => q.instrumentId === instrumentId);
  const last = own.at(-1);
  if (!last) return { kind: 'quote', instrumentId, spendUsd: decimal(plannedSpend) };

  if (last.errorCode !== undefined) {
    if (OFF_HOURS_QUOTE_CODES.has(last.errorCode)) {
      return marketClosed(
        regular ? nowMs + RETRY_LATER_MS : nextRegularOpen(now).getTime() + OPEN_SETTLE_MS,
        last.errorCode,
      );
    }
    return done(
      {
        kind: 'FAILED',
        code: last.errorCode,
        message: last.errorMsg ?? 'quote failed',
        fundsMoved: 'none',
      },
      'why.failed.simulation',
      { code: last.errorCode },
    );
  }
  if (last.quoteId === undefined || last.toTokenAmount === undefined) {
    return done(
      {
        kind: 'FAILED',
        code: 'QUOTE_INCOMPLETE',
        message: 'quote has no quoteId or amount',
        fundsMoved: 'none',
      },
      'why.failed.simulation',
      { code: 'QUOTE_INCOMPLETE' },
    );
  }

  const impact = Number(last.priceImpactPct ?? '0');
  if (impact > MAX_PRICE_IMPACT_PCT) {
    const half = units(last.spendUsd) / 2n;
    const venueMin = chosen.venueMinUsd === null ? 0n : units(chosen.venueMinUsd);
    if (own.length <= MAX_REQUOTES && half >= minBuy && half >= venueMin) {
      return { kind: 'quote', instrumentId, spendUsd: decimal(half) };
    }
    return done(
      { kind: 'DEFERRED', reason: 'quote_impact', retryAt: iso(nowMs + RETRY_LATER_MS) },
      'why.deferred.quote_impact',
      { impact: formatPct(impact) },
    );
  }
  if (nowMs - Date.parse(last.receivedAt) > MAX_QUOTE_AGE_MS) {
    return { kind: 'quote', instrumentId, spendUsd: last.spendUsd };
  }

  // EXECUTE — interest pays first (redeemed-but-unspent, then the position), contributions after.
  const spend = units(last.spendUsd);
  const interestUsed = plan.mode === 'yield' ? smallest(spend, interestAvailable) : null;
  const redeem =
    interestUsed !== null && interestUsed > harvestedUnspent ? interestUsed - harvestedUnspent : 0n;
  return {
    kind: 'execute',
    instrumentId,
    spendUsd: last.spendUsd,
    quote: last,
    redeemUsd: decimal(redeem),
    interestUsd: interestUsed === null ? null : decimal(interestUsed),
    offHours,
    refGapPct,
  };
}

/**
 * The BOUGHT outcome once the swap receipt is in: `receivedTokens` comes from the receipt logs,
 * never from the quote (SPEC §5.8). The interest line is used only when interest paid for all
 * of it.
 */
export function boughtOutcome(
  decision: ExecuteDecision,
  instrument: Instrument,
  receivedTokens: string,
): { outcome: Extract<CycleOutcome, { kind: 'BOUGHT' }>; why: Why } {
  const shares = sharesFromTokens(
    BigInt(receivedTokens),
    instrument.decimals,
    instrument.multiplier,
  );
  const shownShares = formatShares(units(shares));
  const spend = units(decision.spendUsd);
  const outcome = {
    kind: 'BOUGHT' as const,
    spendUsd: decision.spendUsd,
    tokens: receivedTokens,
    shares,
    interestUsd: decision.interestUsd,
    refGapPct: decision.refGapPct,
  };
  if (decision.interestUsd !== null && units(decision.interestUsd) === spend) {
    return {
      outcome,
      why: {
        key: 'why.bought.interest',
        params: { interest: formatUsd(spend), ticker: instrument.ticker, shares: shownShares },
      },
    };
  }
  const params: Record<string, string> = {
    ticker: instrument.ticker,
    shares: shownShares,
    usd: formatUsd(spend),
  };
  if (decision.refGapPct !== null) params.gap = decision.refGapPct;
  return {
    outcome,
    why: { key: decision.offHours ? 'why.bought.anytime' : 'why.bought.regular', params },
  };
}
