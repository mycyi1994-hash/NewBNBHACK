/**
 * The public read routes (SPEC §8.2, TASKS M2-12, M2-11): health, the judge smoke check, tape and
 * market state with LIVE / STALE / UNAVAILABLE, the receipt feed, the house plans and the /dx
 * numbers. They read what the worker wrote; the web never calls the Binance Web3 API.
 */
import { randomUUID } from 'node:crypto';
import {
  apiCalls,
  createDb,
  dxEvents,
  insertApiCall,
  insertPlan,
  openCycle,
  recordDxEvent,
  recordReceiptFacts,
  tapeSamples,
  updateCycle,
  upsertHolding,
  workerStatus,
  writeWorkerStatus,
  type InstrumentRow,
  type PlanInsert,
} from '@ijaro/db';
import { like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as dxMetrics } from '../app/api/dx/metrics/route';
import { GET as dxTape } from '../app/api/dx/tape/route';
import { GET as health } from '../app/api/health/route';
import { GET as house } from '../app/api/house/route';
import { GET as instrumentsRoute } from '../app/api/instruments/route';
import { GET as smoke } from '../app/api/judge/smoke/route';
import { GET as marketStatus } from '../app/api/market/status/route';
import { GET as receiptsRoute } from '../app/api/receipts/route';
import { GET as tapeLatest } from '../app/api/tape/latest/route';
import { setChainForTests } from '../lib/server/chain';
import { resetContext } from '../lib/server/context';
import { webTestUrl } from './db';
import { call, cleanup, fakeWebChain, randomHash, testInstrument, writeTape } from './harness';

const VTOKEN = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface Smoke {
  status: 'green' | 'degraded' | 'red';
  checks: Record<string, { state: string; detail: Record<string, unknown> }>;
}

describe.skipIf(!webTestUrl)('public read routes', () => {
  const { db, close } = createDb(webTestUrl ?? 'postgres://unused');
  const chain = fakeWebChain();
  const marker = `/api/v1/web-test/${randomUUID()}`;
  const planIds: string[] = [];
  let instrument: InstrumentRow;

  beforeAll(async () => {
    // This file owns the web tests' worker state: start from a worker that never ran.
    await db.delete(workerStatus);
    await db.delete(tapeSamples);
    instrument = await testInstrument(db);
    setChainForTests(chain);
  });
  afterAll(async () => {
    setChainForTests(undefined);
    await db.delete(workerStatus);
    await db.delete(apiCalls).where(like(apiCalls.endpoint, `${marker}%`));
    await db.delete(dxEvents).where(like(dxEvents.endpoint, `${marker}%`));
    await cleanup(db, { planIds, instrumentIds: [instrument.id] });
    await resetContext();
    await close();
  });

  async function housePlan(overrides: Partial<PlanInsert> = {}) {
    const id = `T-${randomUUID()}`;
    await insertPlan(db, {
      id,
      ownerKind: 'house',
      mode: 'safe',
      ticker: instrument.ticker,
      issuerPreference: ['bstocks', 'ondo'],
      contributionUsd: '5',
      cadence: 'daily',
      window: 'regular_session',
      maxPerBuyUsd: '5',
      maxDailyUsd: '5',
      nextDueAt: '2026-09-28T13:32:00.000Z',
      ...overrides,
    });
    planIds.push(id);
    return id;
  }

  it('health answers', async () => {
    const res = await call(health, { path: '/api/health' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: 'web' });
  });

  it('tape: UNAVAILABLE with a reason, then STALE with its time, then LIVE', async () => {
    const empty = await call(tapeLatest, { path: '/api/tape/latest' });
    expect(empty.status).toBe(503);
    expect(empty.body).toEqual({ state: 'UNAVAILABLE', reason: 'no tape samples yet' });

    const old = minutesAgo(25);
    await writeTape(db, instrument, old);
    const stale = await call(tapeLatest, { path: '/api/tape/latest' });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ state: 'STALE', sampledAt: old });

    await writeTape(db, instrument, minutesAgo(1));
    const live = await call<{ state: string; rows: unknown[] }>(tapeLatest, {
      path: '/api/tape/latest',
    });
    expect(live.body.state).toBe('LIVE');
    expect(live.body.rows).toHaveLength(3);

    const market = await call(marketStatus, { path: '/api/market/status' });
    expect(market.body).toMatchObject({ data: { state: 'LIVE' } });
    expect(
      (market.body.instruments as { id: string }[]).find((i) => i.id === instrument.id),
    ).toEqual({
      id: instrument.id,
      ticker: instrument.ticker,
      issuer: 'bstocks',
      symbol: instrument.symbol,
      address: instrument.address,
      multiplier: instrument.multiplier,
      reasonCode: 'TRADING',
      reasonMsg: null,
      // 225.175 per token ÷ 1.000778… tokens per share, against the US price of 225: a gap of
      // −0.00004 %, shown as 0.00 (never "-0.00").
      onchainSharePriceUsd: '224.999900',
      stockPriceUsd: '225',
      gapPct: '0.00',
      venueMinUsd: null,
    });
    expect(Date.parse(market.body.nextBuyWindow as string)).toBeGreaterThan(Date.now() - 1);

    const registry = await call<{ instruments: { id: string; address: string }[] }>(
      instrumentsRoute,
      { path: '/api/instruments' },
    );
    expect(registry.body.instruments).toContainEqual(
      expect.objectContaining({ id: instrument.id, address: instrument.address }),
    );
  });

  it('smoke is red (503) until the worker has ticked, green when every check passes', async () => {
    const before = await call<Smoke>(smoke, { path: '/api/judge/smoke' });
    expect(before.status).toBe(503);
    expect(before.body.status).toBe('red');
    expect(before.body.checks.database?.state).toBe('green');
    expect(before.body.checks.worker).toEqual({
      state: 'red',
      detail: { reason: 'no tick recorded' },
    });

    await writeWorkerStatus(db, 'tick', {
      at: new Date().toISOString(),
      mode: 'simulate',
      errors: [],
    });
    await writeWorkerStatus(db, 'house', {
      usdtUnits: '12500000000000000000',
      bnbWei: '5000000000000000',
      at: new Date().toISOString(),
    });
    await insertApiCall(db, {
      ts: minutesAgo(2),
      region: 'fra',
      module: 'rwa',
      endpoint: `${marker}/smoke`,
      method: 'GET',
      httpStatus: 200,
      code: '0',
      msg: 'success',
      latencyMs: 180,
      requestId: null,
      retryCount: 0,
      fixturePath: null,
    });
    const id = await housePlan();
    const hash = randomHash();
    await recordReceiptFacts(db, id, null, {
      kind: 'swap',
      txHash: hash,
      broadcastVia: 'transaction_api',
      blockNumber: 62_000_000n,
      status: 'success',
      amounts: {},
    });
    await writeTape(db, instrument, minutesAgo(0.5));

    const green = await call<Smoke>(smoke, { path: '/api/judge/smoke' });
    expect(green.status).toBe(200);
    expect(green.body.status).toBe('green');
    expect(green.body.checks).toMatchObject({
      worker: { state: 'green', detail: { mode: 'simulate', errors: [] } },
      web3api: { state: 'green', detail: { endpoint: `${marker}/smoke`, latencyMs: 180 } },
      rpc: { state: 'green', detail: { block: '62000000' } },
      house: { state: 'green', detail: { usdt: '12.5', bnb: '0.005' } },
      receipts: { state: 'green', detail: { last: { txHash: hash, kind: 'swap' } } },
      tape: { state: 'green', detail: { state: 'LIVE' } },
    });

    chain.rpcDown = true;
    try {
      const down = await call<Smoke>(smoke, { path: '/api/judge/smoke' });
      expect(down.status).toBe(503);
      expect(down.body.checks.rpc).toEqual({ state: 'red', detail: { error: 'fetch failed' } });
    } finally {
      chain.rpcDown = false;
    }
  });

  it('lists receipts with their reason, and the house plans with interest read on chain', async () => {
    const safe = await housePlan();
    const { cycle } = await openCycle(db, {
      planId: safe,
      dueAt: minutesAgo(3),
      executionMode: 'live',
    });
    const hash = randomHash();
    await recordReceiptFacts(db, safe, cycle.id, {
      kind: 'swap',
      txHash: hash,
      broadcastVia: 'transaction_api',
      blockNumber: 62_000_001n,
      status: 'success',
      amounts: { spentUsdtUnits: '5000000000000000000' },
    });
    await updateCycle(db, cycle.id, {
      state: 'done',
      outcomeKind: 'BOUGHT',
      outcome: { kind: 'BOUGHT', instrumentId: instrument.id },
      whyKey: 'why.bought.regular',
      whyParams: { shares: '0.0222', ticker: instrument.ticker },
      finishedAt: new Date().toISOString(),
    });
    await upsertHolding(db, {
      planId: safe,
      instrumentId: instrument.id,
      tokens: '22212154002358265',
      decimals: 18,
      multiplierAtLastUpdate: instrument.multiplier,
      shares: '0.022194882471391432',
      costUsd: '5',
    });

    const feed = await call<{ receipts: Record<string, unknown>[] }>(receiptsRoute, {
      path: '/api/receipts?limit=5',
    });
    expect(feed.body.receipts[0]).toMatchObject({
      planId: safe,
      owner: 'house',
      ticker: instrument.ticker,
      kind: 'swap',
      txHash: hash,
      explorerUrl: `https://bscscan.com/tx/${hash}`,
      why: { key: 'why.bought.regular', params: { ticker: instrument.ticker } },
    });
    const clamped = await call<{ receipts: unknown[] }>(receiptsRoute, {
      path: '/api/receipts?limit=abc',
    });
    expect(clamped.status).toBe(200);

    // A yield house plan: 50 vUSDT at 0.0204 USDT each is $1.02 against $1 of principal.
    await writeWorkerStatus(db, 'venus', { vToken: VTOKEN, investmentId: 'venus-test' });
    chain.rate = 204_000_000_000_000_000_000_000_000n;
    const yieldPlan = await housePlan({
      mode: 'yield',
      contributionUsd: '0',
      principalUsd: '1',
      vtokenUnits: '5000000000',
      cadence: 'weekly',
    });
    const view = await call<{ plans: Record<string, unknown>[] }>(house, { path: '/api/house' });
    const byId = new Map(view.body.plans.map((p) => [p.id as string, p]));
    expect(byId.get(safe)).toMatchObject({
      mode: 'safe',
      ticker: instrument.ticker,
      interest: { state: 'UNAVAILABLE', usd: null, reason: 'not a yield plan' },
      holdings: [{ instrumentId: instrument.id, tokens: '22212154002358265', costUsd: '5' }],
      last: { outcome: 'BOUGHT', why: { key: 'why.bought.regular' } },
    });
    expect(byId.get(yieldPlan)).toMatchObject({
      mode: 'yield',
      principalUsd: '1',
      interest: { state: 'LIVE', usd: '0.02' },
      last: null,
    });
  });

  it('serves the /dx numbers from api_calls, dx_events and the tape', async () => {
    const endpoint = `${marker}/quote`;
    for (const [latencyMs, code] of [
      [100, '0'],
      [300, '40375'],
      [200, '0'],
    ] as const) {
      await insertApiCall(db, {
        ts: minutesAgo(10),
        region: 'fra',
        module: 'trading',
        endpoint,
        method: 'GET',
        httpStatus: 200,
        code,
        msg: null,
        latencyMs,
        requestId: null,
        retryCount: 0,
        fixturePath: null,
      });
    }
    await recordDxEvent(db, {
      ts: minutesAgo(10),
      kind: 'unknown_code',
      module: 'trading',
      endpoint,
      code: '40399',
      httpStatus: 200,
      msg: 'something new',
      requestId: null,
      region: 'fra',
      meaning: 'not in the documented list',
    });

    const metrics = await call<{
      endpoints: { endpoint: string }[];
      findings: { endpoint: string }[];
      since: string;
    }>(dxMetrics, { path: '/api/dx/metrics?days=1' });
    expect(metrics.status).toBe(200);
    expect(metrics.body.endpoints.find((e) => e.endpoint === endpoint)).toEqual({
      module: 'trading',
      endpoint,
      calls: 3,
      errors: 1,
      p50Ms: 200,
      p95Ms: 300,
      codes: { '0': 2, '40375': 1 },
    });
    expect(metrics.body.findings.find((f) => f.endpoint === endpoint)).toMatchObject({
      kind: 'unknown_code',
      code: '40399',
      logged: false,
    });
    expect(Date.now() - Date.parse(metrics.body.since)).toBeLessThan(86_400_000 + 60_000);
    const wide = await call<{ since: string }>(dxMetrics, { path: '/api/dx/metrics?days=999' });
    expect(Date.now() - Date.parse(wide.body.since)).toBeGreaterThan(29 * 86_400_000);

    const tape = await call<{ rows: Record<string, unknown>[]; method: string }>(dxTape, {
      path: '/api/dx/tape?days=1',
    });
    expect(tape.body.method).toContain('never executed');
    expect(tape.body.rows).toContainEqual({
      session: 'regular',
      sizeUsd: 5,
      issuer: 'bstocks',
      quotes: expect.any(Number) as unknown,
      quoteErrors: 0,
      avgImpactPct: '0.0500',
      avgGapPct: '0.0000',
      gapSamples: expect.any(Number) as unknown,
    });
  });

  it('answers UNAVAILABLE, not an error, for a web without a database', async () => {
    await resetContext();
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';
    try {
      for (const handler of [house, instrumentsRoute, marketStatus, tapeLatest]) {
        const res = await call(handler, { path: '/api/x' });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ state: 'UNAVAILABLE', reason: 'no DATABASE_URL' });
      }
      const res = await call<Smoke>(smoke, { path: '/api/judge/smoke' });
      expect([res.status, res.body.status]).toEqual([503, 'red']);
    } finally {
      process.env.DATABASE_URL = saved;
      await resetContext();
    }
  });
});
