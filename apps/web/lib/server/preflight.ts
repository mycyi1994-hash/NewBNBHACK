/**
 * "Would Yieldvest buy this right now?" (DECISIONS D-31, feature F1): the agent's own rules run on
 * a plan that does not exist yet. The verdict for each issuer is nextFor's — decideCycle on the
 * worker's latest tape, the answer GET /api/plans/:id/next would give a fixed-amount skill plan
 * with these settings — and every rule's input is listed next to its limit, with the time it was
 * read, so a person can see why. Read-only: no plan, no token, no command to run.
 */
import {
  CORPORATE_ACTION_CODES,
  fromUnits,
  MAX_PRICE_GAP_PCT,
  MAX_PRICE_IMPACT_PCT,
  nextRegularOpen,
  OFF_HOURS_QUOTE_CODES,
  OPEN_SETTLE_MS,
  SESSION_CLOSED_CODES,
  STATUS_UNAVAILABLE,
  toUnits,
  usSession,
  type Instrument,
  type InstrumentMarket,
  type Issuer,
  type Plan,
  type PlanWindow,
  type UsSession,
  type Why,
} from '@yieldvest/core';
import { instrumentFromRow, listInstruments, type Db } from '@yieldvest/db';
import {
  estimateQuote,
  gapPctText,
  marketsFromTape,
  TAPE_FRESH_MS,
  tapeView,
  type TapeView,
} from './market';
import { NEXT_TTL_MS, nextFor } from './next';
import { guardianState, type GuardianState } from './worker';

export type CheckState = 'pass' | 'wait' | 'block' | 'unknown' | 'na';

/**
 * One rule's input against its limit. Units by id — data: age in seconds; guardian: the open
 * rules that stop buying; session: our NYSE session against the plan's window; amount: USD this
 * buy may spend now against the smallest order; status: the token's reason code against TRADING;
 * gap: on-chain share price over the US price, percent; impact: the tape quote's price impact,
 * percent.
 */
export interface Check {
  id: 'data' | 'guardian' | 'session' | 'amount' | 'status' | 'gap' | 'impact';
  state: CheckState;
  value: string | null;
  limit: string | null;
  /** When the input was read; null when it was not read at all. */
  at: string | null;
  /** A machine word: why a rule does not apply, or what it saw (off_hours, cash_dividend, halved). */
  note?: string;
  /**
   * impact: the code the recorded quote failed with — a number is the Trading API refusing it
   * (40375 under the venue minimum), anything else the recording failing (timeout, EMPTY).
   */
  code?: string;
  /** impact: the amount the quote estimate is for (after any halving the engine did). */
  basisUsd?: string;
}

export interface IssuerVerdict {
  issuer: Issuer;
  symbol: string;
  address: string;
  decision: 'buy' | 'wait' | 'skip' | 'failed';
  /** The engine's one-line reason (UX_COPY §4); absent when the data itself was missing. */
  why?: Why;
  /** A machine reason when there is no copy key (data_stale, guardian_unchecked, …). */
  reason?: string;
  retryAt?: string;
  /** For buy: what it would spend, and about how many shares the tape quote was worth. */
  spendUsd?: string;
  estimate?: { shares: string; sampledAt: string | null };
  checks: Check[];
}

export interface Preflight {
  ticker: string;
  usd: string;
  window: PlanWindow;
  at: string;
  session: UsSession;
  /** The next regular open plus the two-minute settle, when a regular-hours plan would try. */
  nextBuyWindow: string;
  data: Pick<TapeView, 'state' | 'sampledAt' | 'ageSeconds'>;
  /** Rules every issuer shares: data age, guardian, session. */
  checks: Check[];
  issuers: IssuerVerdict[];
}

export interface PreflightInput {
  ticker: string;
  /** Only this issuer; both (bStocks first) when absent. */
  issuer?: Issuer;
  usd: string;
  window: PlanWindow;
  instruments: readonly Instrument[];
  tape: TapeView;
  guardian: GuardianState;
  minBuyUsd: string;
  now: Date;
}

const units = (usd: string) => toUnits(usd, 18);
const ISSUER_ORDER: readonly Issuer[] = ['bstocks', 'ondo', 'xstocks'];

function dataCheck(tape: TapeView): Check {
  const limit = String(TAPE_FRESH_MS / 1000);
  const value = tape.ageSeconds === null ? null : String(tape.ageSeconds);
  const state = tape.state === 'LIVE' ? 'pass' : tape.state === 'STALE' ? 'wait' : 'unknown';
  return { id: 'data', state, value, limit, at: tape.sampledAt };
}

function guardianCheck(guardian: GuardianState): Check {
  const blocking = guardian.open.filter(
    (a) => a.action === 'pause_buys' || a.action === 'redeem_all',
  );
  const base = { id: 'guardian' as const, limit: null, at: guardian.checkedAt };
  if (blocking.length > 0) {
    return { ...base, state: 'block', value: blocking.map((a) => a.rule).join(',') };
  }
  if (!guardian.fresh) return { ...base, state: 'unknown', value: null, note: 'not_checked' };
  return { ...base, state: 'pass', value: null };
}

function sessionCheck(now: Date, window: PlanWindow): Check {
  const session = usSession(now);
  const base = { id: 'session' as const, value: session, limit: window, at: now.toISOString() };
  if (session === 'regular') return { ...base, state: 'pass' };
  // An anytime plan buys off-hours at half its limit (DECISIONS D-22); the amount check says
  // whether half still reaches the minimum.
  return window === 'anytime'
    ? { ...base, state: 'pass', note: 'off_hours_half_limit' }
    : { ...base, state: 'wait', note: 'regular_session_only' };
}

/** What this buy may spend now: the whole amount, or half of it off-hours on an anytime plan. */
function spendNow(usd: string, window: PlanWindow, regular: boolean): bigint {
  return !regular && window === 'anytime' ? units(usd) / 2n : units(usd);
}

function amountCheck(market: InstrumentMarket, input: PreflightInput, regular: boolean): Check {
  const min = [input.minBuyUsd, market.venueMinUsd ?? '0']
    .map(units)
    .reduce((a, b) => (b > a ? b : a));
  const now = spendNow(input.usd, input.window, regular);
  const base = {
    id: 'amount' as const,
    value: fromUnits(now, 18),
    limit: fromUnits(min, 18),
    at: null,
  };
  const halved = now < units(input.usd);
  if (now >= min) return { ...base, state: 'pass', ...(halved ? { note: 'off_hours_half' } : {}) };
  // Only the off-hours half is too small: the whole amount applies in the regular session.
  if (units(input.usd) >= min) return { ...base, state: 'wait', note: 'half_limit_below_min' };
  return { ...base, state: 'block', note: market.venueMinUsd ? 'venue_minimum' : 'below_min' };
}

function statusCheck(market: InstrumentMarket, at: string | null): Check {
  const { status } = market;
  const code = status.reasonCode ?? 'UNKNOWN';
  const base = { id: 'status' as const, value: code, limit: 'TRADING', at };
  const note = status.reasonMsg ? { note: status.reasonMsg } : {};
  if (code === STATUS_UNAVAILABLE) return { ...base, state: 'unknown', at: null };
  if (status.openState === true && code === 'TRADING') return { ...base, state: 'pass' };
  if (CORPORATE_ACTION_CODES.has(code)) return { ...base, state: 'block', ...note };
  if (SESSION_CLOSED_CODES.has(code)) return { ...base, state: 'wait', ...note };
  return { ...base, state: 'block', ...note };
}

function gapCheck(market: InstrumentMarket, regular: boolean, at: string | null): Check {
  const gap = gapPctText(market.onchainSharePriceUsd, market.independentSharePriceUsd);
  const base = { id: 'gap' as const, value: gap, limit: String(MAX_PRICE_GAP_PCT), at };
  // decideCycle holds the premium against the US price in the regular session only, and only
  // when there is an independent price to hold it against.
  if (!regular) return { ...base, state: 'na', note: 'off_hours' };
  if (gap === null) return { ...base, state: 'na', at: null, note: 'no_us_price' };
  // The engine compares the unrounded gap (2.004 % waits though it reads "2.00"); so does this.
  const raw =
    (Number(market.onchainSharePriceUsd) / Number(market.independentSharePriceUsd) - 1) * 100;
  return { ...base, state: raw > MAX_PRICE_GAP_PCT ? 'wait' : 'pass' };
}

/** The tape quote's price impact for `spendUsd`, against the 1 % limit. */
function impactCheck(input: PreflightInput, market: InstrumentMarket, spendUsd: string): Check {
  const quote = estimateQuote(input.tape.rows, market.instrument.id, spendUsd, input.now);
  const base = {
    id: 'impact' as const,
    value: quote.priceImpactPct ?? null,
    limit: String(MAX_PRICE_IMPACT_PCT),
    at: input.tape.sampledAt,
    basisUsd: spendUsd,
  };
  const code = quote.errorCode;
  if (code === 'NO_TAPE') return { ...base, state: 'unknown', at: null, note: 'no_tape' };
  if (code !== undefined) {
    // A number is the Trading API refusing the quote: refused outside the session, it waits; any
    // other refusal (40375 under the venue minimum, 40374 no liquidity) rules this issuer out for
    // the cycle. Anything else is the recording failing (timeout, EMPTY): nobody knows the answer.
    if (!/^\d+$/.test(code)) return { ...base, state: 'unknown', code };
    return { ...base, state: OFF_HOURS_QUOTE_CODES.has(code) ? 'wait' : 'block', code };
  }
  const impact = Number(quote.priceImpactPct ?? NaN);
  if (!Number.isFinite(impact)) return { ...base, state: 'unknown', note: 'impact_unknown' };
  // Above the limit the agent halves the amount and asks again; it may still buy less.
  if (impact > MAX_PRICE_IMPACT_PCT) return { ...base, state: 'wait', note: 'would_halve' };
  return { ...base, state: 'pass' };
}

/**
 * Why `usd` cannot be a pre-flight amount, or null: the same bounds a skill plan's per-buy limit
 * has (POST /api/plans) — at least the minimum buy, at most the house per-transaction cap.
 */
export function preflightAmountProblem(
  usd: string,
  caps: { minBuyUsd: string; maxPerTxUsd: string },
): string | null {
  const amount = units(usd);
  if (amount < units(caps.minBuyUsd) || amount > units(caps.maxPerTxUsd)) {
    return `usd must be in [${caps.minBuyUsd}, ${caps.maxPerTxUsd}]`;
  }
  return null;
}

/** The pre-flight answer from what the worker recorded; pure, so every branch is a unit test. */
export function preflightFrom(input: PreflightInput): Preflight {
  const { now, tape, guardian } = input;
  const regular = usSession(now) === 'regular';
  const own = input.instruments
    .filter((i) => i.ticker === input.ticker)
    .filter((i) => input.issuer === undefined || i.issuer === input.issuer)
    .sort((a, b) => ISSUER_ORDER.indexOf(a.issuer) - ISSUER_ORDER.indexOf(b.issuer));
  const markets = marketsFromTape(own, tape.rows);
  const blocking = guardian.open.find(
    (a) => a.action === 'pause_buys' || a.action === 'redeem_all',
  );
  const verdict = blocking
    ? { blocked: true as const, rule: blocking.rule }
    : { blocked: false as const };

  const issuers = markets.map((market): IssuerVerdict => {
    const { instrument } = market;
    // A fixed-amount plan for this one token: what a skill plan with these settings would be.
    const plan: Plan = {
      id: `preflight:${instrument.id}`,
      owner: { kind: 'skill', token: '' },
      mode: 'safe',
      target: { type: 'ticker', ticker: input.ticker },
      issuerPreference: [instrument.issuer],
      principalUsd: '0',
      contributionUsd: input.usd,
      cadence: 'once',
      window: input.window,
      limits: { maxPerBuyUsd: input.usd, maxDailyUsd: input.usd },
      status: 'active',
      createdAt: now.toISOString(),
      nextDueAt: now.toISOString(),
    };
    const answer = nextFor({
      plan,
      instruments: [instrument],
      tape,
      caps: { minBuyUsd: input.minBuyUsd, maxPerTxUsd: input.usd },
      dailyRemainingUsd: input.usd,
      dailyLimitUsd: input.usd,
      guardian: verdict,
      now,
    });
    const asked = fromUnits(spendNow(input.usd, input.window, regular), 18);
    // A buy the engine halved for price impact is read at the amount it settled on, with a note;
    // otherwise the rule reads the amount asked for.
    const halved = answer.decision === 'buy' && units(answer.spendUsd) < units(asked);
    const impact = halved
      ? { ...impactCheck(input, market, answer.spendUsd), note: 'halved' }
      : impactCheck(input, market, asked);
    const checks = [
      amountCheck(market, input, regular),
      statusCheck(market, tape.sampledAt),
      gapCheck(market, regular, tape.sampledAt),
      impact,
    ];
    const head = {
      issuer: instrument.issuer,
      symbol: instrument.symbol,
      address: instrument.address,
      checks,
    };
    if (answer.decision === 'buy') {
      // A buy needs the guardian's all-clear: when nobody checked lately, it waits.
      if (!guardian.fresh) {
        return {
          ...head,
          decision: 'wait',
          reason: 'guardian_unchecked',
          retryAt: new Date(now.getTime() + NEXT_TTL_MS).toISOString(),
        };
      }
      return {
        ...head,
        decision: 'buy',
        spendUsd: answer.spendUsd,
        estimate: { shares: answer.estimate.shares, sampledAt: answer.estimate.sampledAt },
      };
    }
    return {
      ...head,
      decision: answer.decision,
      ...(answer.why ? { why: answer.why } : {}),
      ...(answer.reason ? { reason: answer.reason } : {}),
      ...(answer.retryAt ? { retryAt: answer.retryAt } : {}),
    };
  });

  return {
    ticker: input.ticker,
    usd: input.usd,
    window: input.window,
    at: now.toISOString(),
    session: usSession(now),
    nextBuyWindow: new Date(nextRegularOpen(now).getTime() + OPEN_SETTLE_MS).toISOString(),
    data: { state: tape.state, sampledAt: tape.sampledAt, ageSeconds: tape.ageSeconds },
    checks: [dataCheck(tape), guardianCheck(guardian), sessionCheck(now, input.window)],
    issuers,
  };
}

/**
 * GET /api/preflight, the /check page and the MCP tool. Undefined when the registry has no such
 * ticker (or not from that issuer).
 */
export async function preflight(
  db: Db,
  query: { ticker: string; issuer?: Issuer; usd: string; window: PlanWindow },
  minBuyUsd: string,
  now = new Date(),
): Promise<Preflight | undefined> {
  const instruments = (await listInstruments(db))
    .filter((i) => i.ticker === query.ticker)
    .filter((i) => query.issuer === undefined || i.issuer === query.issuer)
    .map(instrumentFromRow);
  if (instruments.length === 0) return undefined;
  const [tape, guardian] = await Promise.all([tapeView(db, now), guardianState(db, now)]);
  return preflightFrom({ ...query, instruments, tape, guardian, minBuyUsd, now });
}
