/**
 * The four read-only features of DECISIONS D-31, without a database: the issuer comparison and the
 * pre-flight verdict from hand-built tape runs, the interest projection's arithmetic, and the MCP
 * server's JSON-RPC handling. The route and MCP-client tests against Postgres are in
 * features-db.test.ts.
 */
import { loadConfig } from '@yieldvest/config';
import {
  formatShares,
  fromUnits,
  sharesFromTokens,
  toUnits,
  type Instrument,
} from '@yieldvest/core';
import type { TapeSampleRow } from '@yieldvest/db';
import { describe, expect, it } from 'vitest';
import { firstBuyUsd, projectInterest, startingDeposit } from '../lib/projection';
import { compareFromTape } from '../lib/server/compare';
import type { TapeView } from '../lib/server/market';
import { mcpReply, MCP_PROTOCOL_VERSIONS, toolList, type ToolContext } from '../lib/server/mcp';
import { preflightAmountProblem, preflightFrom, type Check } from '../lib/server/preflight';
import type { GuardianState } from '../lib/server/worker';
import { TOKENS_PER_USD } from './harness';

/** Thursday 1 Oct 2026, 11:00 in New York: the regular session. */
const REGULAR = new Date('2026-10-01T15:00:00.000Z');
/** Thursday 1 Oct 2026, 19:00 in New York: after hours. */
const AFTER_HOURS = new Date('2026-10-01T23:00:00.000Z');

const BSTOCKS: Instrument = {
  id: 'NVDA:bstocks',
  ticker: 'NVDA',
  issuer: 'bstocks',
  chainId: 56,
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'NVDAB',
  decimals: 18,
  multiplier: '1.000778223752807865',
  verifiedAt: '2026-09-24T00:45:40.000Z',
};
const ONDO: Instrument = {
  ...BSTOCKS,
  id: 'NVDA:ondo',
  issuer: 'ondo',
  address: '0x2222222222222222222222222222222222222222',
  symbol: 'NVDAon',
  multiplier: '1',
};
/** Ondo's quote is worth a little less: 0.1 % fewer tokens per dollar. */
const ONDO_TOKENS_PER_USD = (TOKENS_PER_USD * 999n) / 1000n;

let nextId = 1;
function row(
  instrument: Instrument,
  sizeUsd: number,
  at: Date,
  overrides: Partial<TapeSampleRow> = {},
): TapeSampleRow {
  const perUsd = instrument.issuer === 'ondo' ? ONDO_TOKENS_PER_USD : TOKENS_PER_USD;
  return {
    id: nextId++,
    sampledAt: at.toISOString(),
    slotAt: at.toISOString(),
    instrumentId: instrument.id,
    session: 'regular',
    openState: true,
    marketStatus: null,
    reasonCode: 'TRADING',
    reasonMsg: null,
    nextOpenTime: null,
    tokenPrice: '225.175',
    referencePrice: '225.1',
    stockPrice: '225',
    stockPriceError: null,
    priceUpdatedAt: at.toISOString(),
    sizeUsd,
    expectedOut: (perUsd * BigInt(sizeUsd)).toString(),
    priceImpactPct: '0.05',
    vendor: 'test',
    executionMode: 'SWAP',
    route: null,
    errorCode: null,
    errorMsg: null,
    latencyMs: 120,
    ...overrides,
  };
}

function tape(
  rows: TapeSampleRow[],
  now: Date,
  state: TapeView['state'] = 'LIVE',
  ageSeconds = 60,
): TapeView {
  const sampledAt = new Date(now.getTime() - ageSeconds * 1000).toISOString();
  return {
    state,
    sampledAt: rows.length > 0 ? sampledAt : null,
    slotAt: rows.length > 0 ? sampledAt : null,
    ageSeconds: rows.length > 0 ? ageSeconds : null,
    rows,
  };
}

const run = (
  instruments: Instrument[],
  at: Date,
  overrides: (i: Instrument, size: number) => Partial<TapeSampleRow> = () => ({}),
) => instruments.flatMap((i) => [5, 50, 500].map((size) => row(i, size, at, overrides(i, size))));

const clear = (now: Date): GuardianState => ({
  checkedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
  fresh: true,
  open: [],
});

const shares = (tokens: bigint, multiplier: string) =>
  formatShares(toUnits(sharesFromTokens(tokens, 18, multiplier), 18));

const byId = (checks: Check[], id: Check['id']) => checks.find((c) => c.id === id);

describe('compareFromTape (F2)', () => {
  it('puts both issuers side by side and names the quote worth more shares at each size', () => {
    const view = compareFromTape(
      'NVDA',
      [BSTOCKS, ONDO],
      tape(run([BSTOCKS, ONDO], REGULAR), REGULAR),
    );
    expect(view.issuers.map((s) => s.issuer)).toEqual(['bstocks', 'ondo']);
    const [b, o] = view.issuers;
    expect(b?.quotes.map((q) => q.sizeUsd)).toEqual([5, 50, 500]);
    expect(b?.quotes[1]?.shares).toBe(shares(TOKENS_PER_USD * 50n, BSTOCKS.multiplier));
    expect(o?.quotes[1]?.shares).toBe(shares(ONDO_TOKENS_PER_USD * 50n, '1'));
    // $50 ÷ shares, to four decimals, rounded down.
    expect(Number(b?.quotes[1]?.usdPerShare)).toBeCloseTo(50 / Number(b?.quotes[1]?.shares), 3);
    expect(b?.status).toEqual({ openState: true, reasonCode: 'TRADING', reasonMsg: null });
    expect(b?.gapPct).toBe('0.00');
    expect(b?.venueMinUsd).toBeNull();
    expect(o?.venueMinUsd).toBe('5.01');
    expect(b?.address).toBe(BSTOCKS.address);
    // bStocks: more tokens per dollar and a multiplier above 1 → more shares at every size.
    // (bStocks ÷ Ondo − 1) × 100, rounded down to four decimals: the denominator is Ondo's count.
    for (const size of view.sizes) {
      const usd = BigInt(size.sizeUsd);
      const b = toUnits(sharesFromTokens(TOKENS_PER_USD * usd, 18, BSTOCKS.multiplier), 18);
      const o = toUnits(sharesFromTokens(ONDO_TOKENS_PER_USD * usd, 18, '1'), 18);
      expect(size.moreShares).toBe('bstocks');
      expect(size.byPct).toBe(fromUnits(((b - o) * 1_000_000n) / o, 4));
    }
    expect(view.sizes[1]?.byPct).toBe('0.178');
    expect(view.data).toMatchObject({ state: 'LIVE', ageSeconds: 60 });
  });

  it('shows a refused quote with its code and names no issuer for that size', () => {
    const rows = run([BSTOCKS, ONDO], REGULAR, (i, size) =>
      i.issuer === 'ondo' && size === 5
        ? {
            expectedOut: null,
            priceImpactPct: null,
            errorCode: '40375',
            errorMsg: 'Minimum order amount is 5 USD.',
          }
        : {},
    );
    const view = compareFromTape('NVDA', [BSTOCKS, ONDO], tape(rows, REGULAR));
    const ondo = view.issuers[1];
    expect(ondo?.quotes[0]).toMatchObject({
      sizeUsd: 5,
      shares: null,
      usdPerShare: null,
      priceImpactPct: null,
      errorCode: '40375',
    });
    expect(view.sizes[0]).toEqual({ sizeUsd: 5, moreShares: null, byPct: null });
    expect(view.sizes[1]?.moreShares).toBe('bstocks');
  });

  it('never names an issuer when the two quotes are worth the same number of shares', () => {
    const twin: Instrument = { ...ONDO, multiplier: BSTOCKS.multiplier };
    const rows = run([BSTOCKS, twin], REGULAR, () => ({
      expectedOut: (TOKENS_PER_USD * 5n).toString(),
    }));
    const view = compareFromTape('NVDA', [BSTOCKS, twin], tape(rows, REGULAR));
    expect(view.sizes.every((s) => s.moreShares === null)).toBe(true);
  });

  it('says UNAVAILABLE, with no quotes, when there is no tape', () => {
    const view = compareFromTape('NVDA', [BSTOCKS, ONDO], tape([], REGULAR, 'UNAVAILABLE'));
    expect(view.data.state).toBe('UNAVAILABLE');
    expect(view.issuers.every((s) => s.quotes.length === 0)).toBe(true);
    expect(view.issuers[0]?.status.reasonCode).toBe('UNAVAILABLE');
    expect(view.sizes).toEqual([]);
  });
});

describe('preflightFrom (F1): the agent engine on a plan that does not exist', () => {
  const input = (over: Partial<Parameters<typeof preflightFrom>[0]> = {}) => ({
    ticker: 'NVDA',
    usd: '5',
    window: 'regular_session' as const,
    instruments: [BSTOCKS, ONDO],
    tape: tape(run([BSTOCKS, ONDO], REGULAR), REGULAR),
    guardian: clear(REGULAR),
    minBuyUsd: '0.25',
    now: REGULAR,
    ...over,
  });

  it('would buy in the regular session, with every rule passing, and Ondo under its minimum', () => {
    const answer = preflightFrom(input());
    expect(answer.session).toBe('regular');
    expect(answer.checks.map((c) => [c.id, c.state])).toEqual([
      ['data', 'pass'],
      ['guardian', 'pass'],
      ['session', 'pass'],
    ]);
    const [b, o] = answer.issuers;
    expect(b).toMatchObject({ issuer: 'bstocks', decision: 'buy', spendUsd: '5' });
    expect(b?.estimate?.shares).toBe(shares(TOKENS_PER_USD * 5n, BSTOCKS.multiplier));
    expect(b?.checks.map((c) => c.state)).toEqual(['pass', 'pass', 'pass', 'pass']);
    // Ondo refuses exactly $5.00 (Q-03): the engine skips it with the venue-minimum reason.
    expect(o).toMatchObject({
      issuer: 'ondo',
      decision: 'skip',
      why: {
        key: 'why.skipped.venue_minimum',
        params: { ticker: 'NVDA', min: '5.01', limit: '5.00' },
      },
    });
    expect(byId(o?.checks ?? [], 'amount')).toMatchObject({
      state: 'block',
      value: '5',
      limit: '5.01',
      note: 'venue_minimum',
    });
  });

  it('only one issuer when asked for one', () => {
    const answer = preflightFrom(input({ issuer: 'ondo', usd: '6' }));
    expect(answer.issuers.map((v) => v.issuer)).toEqual(['ondo']);
    expect(answer.issuers[0]?.decision).toBe('buy');
  });

  it('waits for the session after hours on a regular-hours plan, and the gap rule does not apply', () => {
    const answer = preflightFrom(
      input({
        now: AFTER_HOURS,
        tape: tape(run([BSTOCKS], AFTER_HOURS), AFTER_HOURS),
        guardian: clear(AFTER_HOURS),
      }),
    );
    expect(answer.session).toBe('post');
    expect(byId(answer.checks, 'session')).toMatchObject({
      state: 'wait',
      value: 'post',
      limit: 'regular_session',
      note: 'regular_session_only',
    });
    const [b] = answer.issuers;
    expect(b).toMatchObject({ decision: 'wait', why: { key: 'why.deferred.market_closed' } });
    expect(b?.retryAt).toBe(answer.nextBuyWindow);
    expect(byId(b?.checks ?? [], 'gap')).toMatchObject({ state: 'na', note: 'off_hours' });
  });

  it('buys half off-hours on an anytime plan, and says when half is under the minimum', () => {
    const after = {
      now: AFTER_HOURS,
      tape: tape(run([BSTOCKS], AFTER_HOURS), AFTER_HOURS),
      guardian: clear(AFTER_HOURS),
    };
    const half = preflightFrom(input({ ...after, window: 'anytime' }));
    expect(byId(half.checks, 'session')).toMatchObject({
      state: 'pass',
      note: 'off_hours_half_limit',
    });
    expect(half.issuers[0]).toMatchObject({ decision: 'buy', spendUsd: '2.5' });
    expect(byId(half.issuers[0]?.checks ?? [], 'amount')).toMatchObject({
      state: 'pass',
      value: '2.5',
      note: 'off_hours_half',
    });

    const tooSmall = preflightFrom(input({ ...after, window: 'anytime', usd: '0.4' }));
    expect(tooSmall.issuers[0]?.decision).toBe('wait');
    expect(byId(tooSmall.issuers[0]?.checks ?? [], 'amount')).toMatchObject({
      state: 'wait',
      value: '0.2',
      limit: '0.25',
      note: 'half_limit_below_min',
    });
  });

  it('skips while the guardian holds buying, and names the rule', () => {
    const answer = preflightFrom(
      input({
        guardian: { ...clear(REGULAR), open: [{ rule: 'usdt_depeg', action: 'pause_buys' }] },
      }),
    );
    expect(byId(answer.checks, 'guardian')).toMatchObject({ state: 'block', value: 'usdt_depeg' });
    expect(answer.issuers[0]).toMatchObject({
      decision: 'skip',
      why: { key: 'why.skipped.guardian.hold', params: { rule: 'usdt_depeg' } },
    });
  });

  it('a warn-only rule does not stop a buy', () => {
    const answer = preflightFrom(
      input({
        guardian: {
          ...clear(REGULAR),
          open: [{ rule: 'utilization_high', action: 'stop_deposits' }],
        },
      }),
    );
    expect(byId(answer.checks, 'guardian')?.state).toBe('pass');
    expect(answer.issuers[0]?.decision).toBe('buy');
  });

  it('never reads a missing guardian check as all clear: a buy waits', () => {
    const answer = preflightFrom(input({ guardian: { checkedAt: null, fresh: false, open: [] } }));
    expect(byId(answer.checks, 'guardian')).toMatchObject({
      state: 'unknown',
      note: 'not_checked',
    });
    expect(answer.issuers[0]).toMatchObject({ decision: 'wait', reason: 'guardian_unchecked' });
    // A skip stands either way: it does not need the guardian's all-clear.
    expect(answer.issuers[1]?.decision).toBe('skip');
  });

  it('skips a corporate action instead of switching issuer', () => {
    const rows = run([BSTOCKS, ONDO], REGULAR, () => ({
      openState: false,
      reasonCode: 'ASSET_PAUSED',
      reasonMsg: 'cash_dividend',
    }));
    const answer = preflightFrom(input({ tape: tape(rows, REGULAR), usd: '6' }));
    for (const verdict of answer.issuers) {
      expect(verdict).toMatchObject({
        decision: 'skip',
        why: { key: 'why.skipped.corporate_action.cash_dividend' },
      });
      expect(byId(verdict.checks, 'status')).toMatchObject({
        state: 'block',
        value: 'ASSET_PAUSED',
        note: 'cash_dividend',
      });
    }
  });

  it('waits on a premium over the US price above 2 % in the regular session', () => {
    const rows = run([BSTOCKS], REGULAR, () => ({ stockPrice: '215' }));
    const answer = preflightFrom(input({ tape: tape(rows, REGULAR) }));
    const [b] = answer.issuers;
    expect(byId(b?.checks ?? [], 'gap')).toMatchObject({ state: 'wait', limit: '2' });
    expect(Number(byId(b?.checks ?? [], 'gap')?.value)).toBeGreaterThan(2);
    expect(b).toMatchObject({ decision: 'wait', why: { key: 'why.deferred.price_gap' } });
  });

  it('marks the impact rule when the quote moves the price more than 1 %', () => {
    const rows = run([BSTOCKS], REGULAR, () => ({ priceImpactPct: '1.8' }));
    const answer = preflightFrom(input({ tape: tape(rows, REGULAR) }));
    const [b] = answer.issuers;
    expect(byId(b?.checks ?? [], 'impact')).toMatchObject({
      state: 'wait',
      value: '1.8',
      limit: '1',
      note: 'would_halve',
    });
    expect(b).toMatchObject({ decision: 'wait', why: { key: 'why.deferred.quote_impact' } });
  });

  it('a quote refused off-hours waits, another refusal stops, a failed recording is unknown', () => {
    const impactWith = (errorCode: string) =>
      byId(
        preflightFrom(
          input({
            tape: tape(
              run([BSTOCKS], REGULAR, () => ({ expectedOut: null, errorCode, errorMsg: 'x' })),
              REGULAR,
            ),
          }),
        ).issuers[0]?.checks ?? [],
        'impact',
      );
    expect(impactWith('40369')).toMatchObject({ state: 'wait', code: '40369' });
    expect(impactWith('40374')).toMatchObject({ state: 'block', code: '40374' });
    // The worker's own failures (a timeout, an empty answer) are not the market's answer.
    expect(impactWith('timeout')).toMatchObject({ state: 'unknown', code: 'timeout' });
    expect(impactWith('EMPTY')).toMatchObject({ state: 'unknown', code: 'EMPTY' });
  });

  it('reads the impact at the amount the engine settled on when it halved a buy', () => {
    // $10 is quoted on the $50 row (1.8 %): the engine halves to $5, whose row is at 0.05 %.
    const rows = run([BSTOCKS], REGULAR, (_i, size) =>
      size === 50 ? { priceImpactPct: '1.8' } : {},
    );
    const [b] = preflightFrom(input({ usd: '10', tape: tape(rows, REGULAR) })).issuers;
    expect(b).toMatchObject({ decision: 'buy', spendUsd: '5' });
    expect(byId(b?.checks ?? [], 'impact')).toMatchObject({
      state: 'pass',
      value: '0.05',
      basisUsd: '5',
      note: 'halved',
    });
    // Asked for $5 outright, nothing was halved.
    const [plain] = preflightFrom(input({ tape: tape(rows, REGULAR) })).issuers;
    expect(byId(plain?.checks ?? [], 'impact')).toMatchObject({ state: 'pass', basisUsd: '5' });
    expect(byId(plain?.checks ?? [], 'impact')?.note).toBeUndefined();
  });

  it('holds the gap against its limit unrounded, as the engine does', () => {
    // 224.9999 a share on chain against 220.58: a 2.0036 % premium that reads "2.00".
    const rows = run([BSTOCKS], REGULAR, () => ({ stockPrice: '220.58' }));
    const [b] = preflightFrom(input({ tape: tape(rows, REGULAR) })).issuers;
    expect(byId(b?.checks ?? [], 'gap')).toMatchObject({ value: '2.00', state: 'wait' });
    expect(b).toMatchObject({ decision: 'wait', why: { key: 'why.deferred.price_gap' } });
  });

  it('a tape amount that is not a whole number is no amount, never a crash', () => {
    const rows = run([BSTOCKS], REGULAR, () => ({ expectedOut: '1.5e18' }));
    const answer = preflightFrom(input({ tape: tape(rows, REGULAR) }));
    expect(byId(answer.issuers[0]?.checks ?? [], 'impact')).toMatchObject({
      state: 'unknown',
      note: 'no_tape',
    });
    expect(answer.issuers[0]?.decision).not.toBe('buy');
  });

  it('waits on stale data and says nothing it did not read', () => {
    const stale = preflightFrom(
      input({ tape: tape(run([BSTOCKS], REGULAR), REGULAR, 'STALE', 3600) }),
    );
    expect(byId(stale.checks, 'data')).toMatchObject({
      state: 'wait',
      value: '3600',
      limit: '1200',
    });
    expect(stale.issuers[0]).toMatchObject({ decision: 'wait', reason: 'data_stale' });

    const none = preflightFrom(input({ tape: tape([], REGULAR, 'UNAVAILABLE') }));
    expect(byId(none.checks, 'data')).toMatchObject({ state: 'unknown', value: null, at: null });
    expect(none.issuers[0]).toMatchObject({ decision: 'wait', reason: 'data_unavailable' });
    expect(byId(none.issuers[0]?.checks ?? [], 'status')).toMatchObject({
      state: 'unknown',
      at: null,
    });
    expect(byId(none.issuers[0]?.checks ?? [], 'impact')).toMatchObject({
      state: 'unknown',
      note: 'no_tape',
    });
  });

  it('takes the same amount bounds as a skill plan’s per-buy limit', () => {
    const caps = { minBuyUsd: '0.25', maxPerTxUsd: '25' };
    expect(preflightAmountProblem('0.25', caps)).toBeNull();
    expect(preflightAmountProblem('25', caps)).toBeNull();
    expect(preflightAmountProblem('0.24', caps)).toMatch(/0\.25, 25/);
    expect(preflightAmountProblem('25.01', caps)).toMatch(/0\.25, 25/);
  });
});

describe('projectInterest (F3)', () => {
  const at = (over: Partial<Parameters<typeof projectInterest>[0]> = {}) =>
    projectInterest({
      depositUsd: 1000,
      apyPct: 3.16,
      firstBuyUsd: 0.25,
      sharePriceUsd: 180,
      ...over,
    });

  it('compounds the listed APY daily and finds the first day the first buy is reached', () => {
    const p = at();
    expect(p).toMatchObject({ perYearUsd: '31.600000', daysToFirstBuy: 3 });
    expect(Number(p?.perDayUsd)).toBeCloseTo(1000 * (Math.pow(1.0316, 1 / 365) - 1), 6);
    expect(Number(p?.perWeekUsd)).toBeCloseTo(1000 * (Math.pow(1.0316, 7 / 365) - 1), 6);
    expect(Number(p?.perMonthUsd)).toBeCloseTo(1000 * (Math.pow(1.0316, 30 / 365) - 1), 6);
    expect(Number(p?.sharesPerMonth)).toBeCloseTo(Number(p?.perMonthUsd) / 180, 6);
    // Two days earn less than the minimum, three days more.
    expect(2 * Number(p?.perDayUsd)).toBeLessThan(0.25);
  });

  it("waits for a token's venue minimum: Ondo's $5.01 takes 59 days where $0.25 takes 3", () => {
    expect(at({ firstBuyUsd: Number(firstBuyUsd('0.25', '5.01')) })?.daysToFirstBuy).toBe(59);
    expect(firstBuyUsd('0.25', '5.01')).toBe('5.01');
    expect(firstBuyUsd('0.25', null)).toBe('0.25');
    expect(firstBuyUsd('6', '5.01')).toBe('6');
  });

  it('rounds down, never up — to the cent from $1,000 up, where the last digits are noise', () => {
    const p = at({ depositUsd: 1, sharePriceUsd: null });
    expect(p?.perDayUsd).toBe('0.000085');
    expect(p?.sharesPerMonth).toBeNull();
    expect(p?.daysToFirstBuy).toBe(2618);
    // 999,999,999.99 × 3.16 % = 31,599,999.999684: never shown as …999.999700.
    expect(at({ depositUsd: 999_999_999.99 })?.perYearUsd).toBe('31599999.990000');
    // Exact decimals stay exact: 12,345.67 × 3.16 % = 390.123172.
    expect(at({ depositUsd: 12_345.67 })?.perYearUsd).toBe('390.123172');
  });

  it('at 0 % nothing is ever reached; without a deposit or a rate there is no projection', () => {
    expect(at({ depositUsd: 100, apyPct: 0 })).toMatchObject({
      perYearUsd: '0.000000',
      daysToFirstBuy: null,
    });
    expect(at({ depositUsd: 0 })).toBeNull();
    expect(at({ apyPct: Number.NaN })).toBeNull();
    expect(at({ apyPct: -1 })).toBeNull();
    expect(at({ firstBuyUsd: 0 })).toBeNull();
  });

  it('opens on the principal cut to the cent, or $100 when there is none — never on 0', () => {
    expect(startingDeposit('0')).toBe('100');
    expect(startingDeposit('0.004')).toBe('100');
    expect(startingDeposit(null)).toBe('100');
    expect(startingDeposit('1000')).toBe('1000');
    expect(startingDeposit('4.999999999999999999')).toBe('4.99');
    expect(startingDeposit('2.50')).toBe('2.5');
  });
});

describe('mcpReply (F4): JSON-RPC without a database', () => {
  const ctx: ToolContext = { db: undefined, config: loadConfig(), now: REGULAR };
  const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });

  it('negotiates the protocol version and describes itself', async () => {
    for (const version of MCP_PROTOCOL_VERSIONS) {
      const reply = await mcpReply(
        rpc('initialize', { protocolVersion: version, capabilities: {} }),
        ctx,
      );
      expect(reply).toMatchObject({
        status: 200,
        body: { id: 1, result: { protocolVersion: version } },
      });
    }
    const old = await mcpReply(rpc('initialize', { protocolVersion: '2023-01-01' }), ctx);
    expect(old).toMatchObject({
      status: 200,
      body: {
        result: {
          protocolVersion: MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'yieldvest' },
        },
      },
    });
    expect(JSON.stringify(old)).toContain('read-only');
  });

  it('lists only read-only tools, each with an object input schema', async () => {
    const reply = await mcpReply(rpc('tools/list'), ctx);
    expect(reply.status).toBe(200);
    const tools = (reply as unknown as { body: { result: { tools: ReturnType<typeof toolList> } } })
      .body.result.tools;
    expect(tools.map((t) => t.name)).toEqual([
      'market_status',
      'compare_issuers',
      'preflight',
      'interest_projection',
      'wallet_holdings',
      'plan_status',
      'recent_receipts',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema).not.toHaveProperty('$schema');
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(tools.find((t) => t.name === 'preflight')?.inputSchema).toMatchObject({
      required: ['ticker', 'usd'],
    });
  });

  it('answers ping, accepts notifications and responses with 202, refuses what is not JSON-RPC', async () => {
    expect(await mcpReply(rpc('ping', undefined, 'p'), ctx)).toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 'p', result: {} },
    });
    expect(await mcpReply({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)).toEqual({
      status: 202,
    });
    expect(await mcpReply({ jsonrpc: '2.0', id: 7, result: {} }, ctx)).toEqual({ status: 202 });
    expect(await mcpReply({ id: 1, method: 'ping' }, ctx)).toMatchObject({ status: 400 });
    expect(await mcpReply({ id: 1, method: 'ping' }, ctx)).toMatchObject({
      status: 400,
      body: { error: { code: -32600 } },
    });
    expect(await mcpReply('ping', ctx)).toMatchObject({ status: 400 });
    expect(await mcpReply({ jsonrpc: '2.0', id: 1.5, method: 'ping' }, ctx)).toMatchObject({
      status: 400,
    });
  });

  it('answers a batch (MCP 2025-03-26) with an array, and only up to ten messages', async () => {
    const both = await mcpReply(
      [
        rpc('ping', undefined, 'a'),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        rpc('tools/list', undefined, 'b'),
      ],
      ctx,
    );
    expect(both.status).toBe(200);
    const answers = (both as unknown as { body: { id: string }[] }).body;
    expect(answers.map((a) => a.id)).toEqual(['a', 'b']);
    // Nothing to answer: 202.
    expect(await mcpReply([{ jsonrpc: '2.0', method: 'notifications/initialized' }], ctx)).toEqual({
      status: 202,
    });
    // An invalid element answers with an error of its own; the rest are answered.
    const mixed = await mcpReply([rpc('ping', undefined, 'c'), { id: 9 }], ctx);
    expect(mixed).toMatchObject({
      status: 200,
      body: [
        { id: 'c', result: {} },
        { id: null, error: { code: -32600 } },
      ],
    });
    expect(await mcpReply([], ctx)).toMatchObject({
      status: 400,
      body: { error: { code: -32600 } },
    });
    expect(
      await mcpReply(
        Array.from({ length: 11 }, (_, i) => rpc('ping', undefined, i)),
        ctx,
      ),
    ).toMatchObject({ status: 400, body: { error: { code: -32600 } } });
  });

  it('protocol errors for unknown methods and tools; tool errors for bad arguments', async () => {
    expect(await mcpReply(rpc('resources/list'), ctx)).toMatchObject({
      status: 200,
      body: { id: 1, error: { code: -32601 } },
    });
    expect(
      await mcpReply(rpc('tools/call', { name: 'buy_now', arguments: {} }), ctx),
    ).toMatchObject({
      status: 200,
      body: { error: { code: -32602, message: 'unknown tool: buy_now' } },
    });
    const bad = await mcpReply(
      rpc('tools/call', { name: 'preflight', arguments: { ticker: 'NVDA', usd: '2.505' } }),
      ctx,
    );
    expect(bad).toMatchObject({ status: 200, body: { result: { isError: true } } });
    expect(JSON.stringify(bad)).toContain('usd');
    const notObject = await mcpReply(rpc('tools/call', { name: 'preflight', arguments: [1] }), ctx);
    expect(notObject).toMatchObject({ body: { result: { isError: true } } });
  });

  it('takes a number for a dollar amount, and says when there is no database', async () => {
    const reply = await mcpReply(
      rpc('tools/call', { name: 'preflight', arguments: { ticker: 'nvda', usd: 5 } }),
      ctx,
    );
    expect(reply).toMatchObject({
      status: 200,
      body: {
        result: {
          isError: true,
          content: [{ type: 'text', text: 'unavailable: no database configured' }],
        },
      },
    });
  });
});
