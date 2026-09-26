/**
 * The recorded RWA list (fixtures/rwa/getRwaTokenList-20260924-1.json, US overnight) replayed
 * through marketSnapshot and decideCycle (M2-07): statuses are read as recorded, bStocks' TRADING
 * overnight does not open the regular-session gate, and a real Ondo MARKET_PAUSED instrument is
 * deferred to the API's next open. Token addresses come from the fixture, never from code.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decideCycle, type Plan } from '@ijaro/core';
import { createDb, instruments, upsertInstruments, type InstrumentRow } from '@ijaro/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTestUrl } from '../test/db.js';
import { fakeApi, testClock } from '../test/harness.js';
import { marketSnapshot } from './market.js';

const url = agentTestUrl;
const RECORDED_AT = '2026-09-24T00:46:45.311Z'; // Wed 20:46 ET, overnight

interface RwaRow {
  tokenContractAddress: string;
  platformId: string;
  tokenSymbol: string;
  decimals: string;
  underlyingTicker: string;
  tokenToShareRatio: string | null;
  statusInfo: {
    reasonCode?: string;
    reasonMsg?: string | null;
    nextOpenTime?: number | null;
  } | null;
}

const rows = (
  JSON.parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'fixtures',
        'rwa',
        'getRwaTokenList-20260924-1.json',
      ),
      'utf8',
    ),
  ) as { response: { body: { data: RwaRow[] } } }
).response.body.data;

function registryRow(row: RwaRow, ticker: string): InstrumentRow {
  const issuer = row.platformId === 'bstock' ? 'bstocks' : row.platformId;
  return {
    id: `${ticker}:${issuer}`,
    ticker,
    issuer,
    platformId: row.platformId,
    chainId: 56,
    address: row.tokenContractAddress,
    symbol: row.tokenSymbol,
    decimals: Number(row.decimals),
    assetType: 1,
    multiplier: row.tokenToShareRatio ?? '1',
    multiplierSource: 'api',
    apiShareRatio: row.tokenToShareRatio,
    verifiedAt: RECORDED_AT,
  };
}

const plan = (ticker: string, overrides: Partial<Plan> = {}): Plan => ({
  id: `replay-${ticker}`,
  owner: { kind: 'house' },
  mode: 'safe',
  target: { type: 'ticker', ticker },
  issuerPreference: ['bstocks', 'ondo'],
  principalUsd: '0',
  contributionUsd: '6',
  cadence: 'daily',
  window: 'regular_session',
  limits: { maxPerBuyUsd: '25', maxDailyUsd: '25' },
  status: 'active',
  createdAt: RECORDED_AT,
  nextDueAt: RECORDED_AT,
  ...overrides,
});

describe.skipIf(!url)('recorded RWA list → marketSnapshot → decideCycle', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  // Test-only tickers so the replay never touches registry rows of the real ones.
  const nvda = {
    ticker: 'RPLNVDA',
    bstock: rows.find((r) => r.underlyingTicker === 'NVDA' && r.platformId === 'bstock'),
    ondo: rows.find((r) => r.underlyingTicker === 'NVDA' && r.platformId === 'ondo'),
  };
  const paused = rows.find(
    (r) => r.platformId === 'ondo' && r.statusInfo?.reasonCode === 'MARKET_PAUSED',
  );
  const ids: string[] = [];

  beforeAll(async () => {
    if (!nvda.bstock || !nvda.ondo || !paused) throw new Error('fixture rows missing');
    const registry = [
      registryRow(nvda.bstock, nvda.ticker),
      registryRow(nvda.ondo, nvda.ticker),
      registryRow(paused, 'RPLPAUSED'),
    ];
    ids.push(...registry.map((r) => r.id));
    await upsertInstruments(db, registry);
  });
  afterAll(async () => {
    await db.delete(instruments).where(inArray(instruments.id, ids));
    await close();
  });

  function deps() {
    const clock = testClock(RECORDED_AT);
    return {
      client: fakeApi(clock, {
        '/api/v1/dex/market/rwa/tokens': () => rows,
        '/api/v1/dex/market/rwa/price': () => [],
      }).client,
      db,
      stockQuote: () => Promise.resolve({ ok: true as const, stockPrice: null }),
    };
  }

  const input = (p: Plan, markets: Awaited<ReturnType<typeof marketSnapshot>>['markets']) => ({
    now: new Date(RECORDED_AT),
    plan: p,
    caps: { minBuyUsd: '2', maxPerTxUsd: '25' },
    dailyRemainingUsd: '50',
    dailyLimitUsd: '50',
    markets,
  });

  it('reads the recorded statuses: bStocks TRADING with no market status, Ondo overnight', async () => {
    const { markets, unavailable } = await marketSnapshot(deps(), nvda.ticker);
    expect(unavailable).toEqual([]);
    expect(markets.map((m) => [m.instrument.issuer, m.status.reasonCode, m.venueMinUsd])).toEqual([
      ['bstocks', 'TRADING', null],
      ['ondo', 'TRADING', '5.01'],
    ]);
  });

  it('keeps a regular-session plan closed overnight although bStocks says TRADING (our NYSE calendar)', async () => {
    const { markets } = await marketSnapshot(deps(), nvda.ticker);
    expect(decideCycle(input(plan(nvda.ticker), markets))).toMatchObject({
      kind: 'done',
      outcome: { kind: 'DEFERRED', reason: 'market_closed', retryAt: '2026-09-24T13:32:00.000Z' },
    });
    // An anytime plan goes ahead with the first issuer in its preference.
    expect(decideCycle(input(plan(nvda.ticker, { window: 'anytime' }), markets))).toEqual({
      kind: 'quote',
      instrumentId: `${nvda.ticker}:bstocks`,
      // Off-hours halves the per-buy limit (25 → 12.5), which the $6 budget stays under.
      spendUsd: '6',
    });
  });

  it('defers a MARKET_PAUSED Ondo instrument to the API’s next open', async () => {
    const { markets } = await marketSnapshot(deps(), 'RPLPAUSED');
    expect(markets[0]?.status).toMatchObject({
      reasonCode: 'MARKET_PAUSED',
      reasonMsg: 'Paused for session transition',
    });
    const decision = decideCycle(
      input(plan('RPLPAUSED', { window: 'anytime', issuerPreference: ['ondo'] }), markets),
    );
    const nextOpen = paused?.statusInfo?.nextOpenTime;
    expect(decision).toMatchObject({
      kind: 'done',
      outcome: {
        kind: 'DEFERRED',
        reason: 'market_closed',
        detail: 'MARKET_PAUSED',
        ...(nextOpen ? { retryAt: new Date(nextOpen + 2 * 60_000).toISOString() } : {}),
      },
    });
  });
});
