/**
 * The four read-only features of DECISIONS D-31, without a database: the issuer comparison and the
 * pre-flight verdict from hand-built tape runs, the interest projection's arithmetic, and the MCP
 * server's JSON-RPC handling. The route and MCP-client tests against Postgres are in
 * features-db.test.ts.
 */
import { loadConfig } from '@yieldvest/config';
import { formatShares, sharesFromTokens, toUnits, type Instrument } from '@yieldvest/core';
import type { TapeSampleRow } from '@yieldvest/db';
import { describe, expect, it } from 'vitest';
import { projectInterest } from '../lib/projection';
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
    for (const size of view.sizes) {
      expect(size.moreShares).toBe('bstocks');
      expect(Number(size.byPct)).toBeGreaterThan(0.1);
      expect(Number(size.byPct)).toBeLessThan(0.2);
    }
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

  it('a quote refused off-hours waits; any other refusal stops that issuer', () => {
    const offHours = run([BSTOCKS], REGULAR, () => ({
      expectedOut: null,
      errorCode: '40369',
      errorMsg: 'rfq off hours',
    }));
    expect(
      byId(
        preflightFrom(input({ tape: tape(offHours, REGULAR) })).issuers[0]?.checks ?? [],
        'impact',
      ),
    ).toMatchObject({
      state: 'wait',
      note: '40369',
    });
    const noLiquidity = run([BSTOCKS], REGULAR, () => ({
      expectedOut: null,
      errorCode: '40374',
      errorMsg: 'no liquidity',
    }));
    expect(
      byId(
        preflightFrom(input({ tape: tape(noLiquidity, REGULAR) })).issuers[0]?.checks ?? [],
        'impact',
      ),
    ).toMatchObject({
      state: 'block',
      note: '40374',
    });
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
  it('compounds the listed APY daily and finds the first day the minimum is reached', () => {
    const p = projectInterest({
      depositUsd: 1000,
      apyPct: 3.16,
      minBuyUsd: 0.25,
      sharePriceUsd: 180,
    });
    expect(p).toMatchObject({ perYearUsd: '31.600000', daysToMinBuy: 3 });
    expect(Number(p?.perDayUsd)).toBeCloseTo(1000 * (Math.pow(1.0316, 1 / 365) - 1), 6);
    expect(Number(p?.perWeekUsd)).toBeCloseTo(1000 * (Math.pow(1.0316, 7 / 365) - 1), 6);
    expect(Number(p?.perMonthUsd)).toBeCloseTo(1000 * (Math.pow(1.0316, 30 / 365) - 1), 6);
    expect(Number(p?.sharesPerMonth)).toBeCloseTo(Number(p?.perMonthUsd) / 180, 6);
    // Two days earn less than the minimum, three days more.
    expect(2 * Number(p?.perDayUsd)).toBeLessThan(0.25);
  });

  it('rounds down, never up', () => {
    const p = projectInterest({
      depositUsd: 1,
      apyPct: 3.16,
      minBuyUsd: 0.25,
      sharePriceUsd: null,
    });
    expect(p?.perDayUsd).toBe('0.000085');
    expect(p?.sharesPerMonth).toBeNull();
    expect(p?.daysToMinBuy).toBe(2618);
  });

  it('at 0 % nothing is ever reached; without a deposit or a rate there is no projection', () => {
    expect(
      projectInterest({ depositUsd: 100, apyPct: 0, minBuyUsd: 0.25, sharePriceUsd: 1 }),
    ).toMatchObject({
      perYearUsd: '0.000000',
      daysToMinBuy: null,
    });
    expect(
      projectInterest({ depositUsd: 0, apyPct: 3, minBuyUsd: 0.25, sharePriceUsd: 1 }),
    ).toBeNull();
    expect(
      projectInterest({ depositUsd: 100, apyPct: Number.NaN, minBuyUsd: 0.25, sharePriceUsd: 1 }),
    ).toBeNull();
    expect(
      projectInterest({ depositUsd: 100, apyPct: -1, minBuyUsd: 0.25, sharePriceUsd: 1 }),
    ).toBeNull();
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

  it('answers ping, accepts notifications and responses with 202, refuses batches', async () => {
    expect(await mcpReply(rpc('ping', undefined, 'p'), ctx)).toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 'p', result: {} },
    });
    expect(await mcpReply({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)).toEqual({
      status: 202,
    });
    expect(await mcpReply({ jsonrpc: '2.0', id: 7, result: {} }, ctx)).toEqual({ status: 202 });
    expect(await mcpReply([rpc('ping')], ctx)).toMatchObject({
      status: 400,
      body: { error: { code: -32600 } },
    });
    expect(await mcpReply({ id: 1, method: 'ping' }, ctx)).toMatchObject({
      status: 400,
      body: { error: { code: -32600 } },
    });
    expect(await mcpReply('ping', ctx)).toMatchObject({ status: 400 });
    expect(await mcpReply({ jsonrpc: '2.0', id: 1.5, method: 'ping' }, ctx)).toMatchObject({
      status: 400,
    });
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
