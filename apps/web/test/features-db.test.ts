/**
 * The read-only features of DECISIONS D-31 through their routes, against the web tests' Postgres:
 * GET /api/compare, /api/preflight and /api/projection on tape runs and worker state written the
 * way the worker writes them, and POST /api/mcp driven by the official MCP TypeScript SDK client
 * (@modelcontextprotocol/sdk), so the server is checked against a real client, not our reading
 * of the spec.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createDb,
  guardianEvents,
  insertGuardianEvent,
  tapeSamples,
  upsertInstruments,
  workerStatus,
  writeWorkerStatus,
  type InstrumentRow,
} from '@yieldvest/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as compareRoute } from '../app/api/compare/route';
import { POST as mcpRoute } from '../app/api/mcp/route';
import { GET as preflightRoute } from '../app/api/preflight/route';
import { GET as projectionRoute } from '../app/api/projection/route';
import { resetContext } from '../lib/server/context';
import { webTestUrl } from './db';
import { call, cleanup, randomAddress, testInstrument, writeTape } from './harness';

/** Tuesday 6 Oct 2026, 11:00 in New York: the regular session. */
const NOW = new Date('2026-10-06T15:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

interface Verdict {
  issuer: string;
  decision: string;
  reason?: string;
  why?: { key: string };
  spendUsd?: string;
}

describe.skipIf(!webTestUrl)('read-only feature routes and the MCP server (D-31)', () => {
  const { db, close } = createDb(webTestUrl ?? 'postgres://unused');
  let bstocks: InstrumentRow;
  let ondo: InstrumentRow;
  const events: number[] = [];

  /** The worker's last tick at `at` (the guardian runs inside every tick). */
  async function tick(at: string) {
    await writeWorkerStatus(db, 'tick', { at, mode: 'simulate', errors: [] });
    await db.update(workerStatus).set({ updatedAt: at }).where(eq(workerStatus.key, 'tick'));
  }

  beforeAll(async () => {
    await db.delete(workerStatus);
    await db.delete(tapeSamples);
    bstocks = await testInstrument(db);
    ondo = {
      ...bstocks,
      id: `${bstocks.ticker}:ondo`,
      issuer: 'ondo',
      platformId: 'ondo',
      address: randomAddress(),
      symbol: `${bstocks.ticker}on`,
      multiplier: '1',
      apiShareRatio: '1',
    };
    await upsertInstruments(db, [ondo]);
    await writeTape(db, bstocks, ago(2));
    await writeTape(db, ondo, ago(2));
  });
  beforeEach(() => {
    // Date only: the database driver keeps its real timers.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });
  afterEach(async () => {
    vi.useRealTimers();
    if (events.length > 0)
      await db.delete(guardianEvents).where(inArray(guardianEvents.id, events));
    events.length = 0;
    await db.delete(workerStatus);
  });
  afterAll(async () => {
    await cleanup(db, { instrumentIds: [bstocks.id, ondo.id] });
    await resetContext();
    await close();
  });

  it('GET /api/compare lists the comparable tickers, then compares one', async () => {
    const list = await call<{ tickers: { ticker: string; issuers: string[] }[] }>(compareRoute, {
      path: '/api/compare',
    });
    expect(list.status).toBe(200);
    expect(list.body.tickers).toContainEqual({
      ticker: bstocks.ticker,
      issuers: ['bstocks', 'ondo'],
    });

    const one = await call<{
      data: { state: string };
      issuers: { issuer: string; quotes: { sizeUsd: number; shares: string | null }[] }[];
      sizes: { sizeUsd: number; moreShares: string | null }[];
    }>(compareRoute, { path: `/api/compare?ticker=${bstocks.ticker.toLowerCase()}` });
    expect(one.status).toBe(200);
    expect(one.body.data.state).toBe('LIVE');
    expect(one.body.issuers.map((s) => s.issuer)).toEqual(['bstocks', 'ondo']);
    expect(one.body.issuers[0]?.quotes.map((q) => q.sizeUsd)).toEqual([5, 50, 500]);
    // Same tokens per dollar, and the bStocks multiplier is above 1: more shares at every size.
    expect(one.body.sizes.map((s) => s.moreShares)).toEqual(['bstocks', 'bstocks', 'bstocks']);

    expect((await call(compareRoute, { path: '/api/compare?ticker=QQQQQQ' })).status).toBe(404);
    expect((await call(compareRoute, { path: '/api/compare?ticker=NVDA1' })).status).toBe(400);
  });

  it('GET /api/preflight runs the engine per issuer, and a buy needs a recent guardian check', async () => {
    const path = `/api/preflight?ticker=${bstocks.ticker}&usd=6`;
    // No tick recorded: nobody checked the guardian rules, so nothing would buy.
    const unchecked = await call<{ issuers: Verdict[] }>(preflightRoute, { path });
    expect(unchecked.status).toBe(200);
    expect(unchecked.body.issuers.map((v) => [v.issuer, v.decision, v.reason])).toEqual([
      ['bstocks', 'wait', 'guardian_unchecked'],
      ['ondo', 'wait', 'guardian_unchecked'],
    ]);

    await tick(ago(3));
    const ready = await call<{
      session: string;
      checks: { id: string; state: string }[];
      issuers: Verdict[];
    }>(preflightRoute, { path });
    expect(ready.body.session).toBe('regular');
    expect(ready.body.checks.map((c) => c.state)).toEqual(['pass', 'pass', 'pass']);
    expect(ready.body.issuers.map((v) => [v.issuer, v.decision, v.spendUsd])).toEqual([
      ['bstocks', 'buy', '6'],
      ['ondo', 'buy', '6'],
    ]);
    // It hands out no command: a plan is still created and decided by its own /next.
    expect(JSON.stringify(ready.body)).not.toContain('baw');

    // An old tick is not a check.
    await tick(ago(16));
    const old = await call<{ issuers: Verdict[] }>(preflightRoute, { path });
    expect(old.body.issuers[0]).toMatchObject({ decision: 'wait', reason: 'guardian_unchecked' });

    await tick(ago(1));
    const event = await insertGuardianEvent(db, {
      rule: 'usdt_depeg',
      action: 'pause_buys',
      detail: { priceUsd: '0.98' },
    });
    events.push(event.id);
    const held = await call<{
      checks: { id: string; state: string; value: string }[];
      issuers: Verdict[];
    }>(preflightRoute, { path: `${path}&issuer=bstocks` });
    expect(held.body.checks.find((c) => c.id === 'guardian')).toMatchObject({
      state: 'block',
      value: 'usdt_depeg',
    });
    expect(held.body.issuers).toHaveLength(1);
    expect(held.body.issuers[0]).toMatchObject({
      decision: 'skip',
      why: { key: 'why.skipped.guardian.hold' },
    });
  });

  it('GET /api/preflight refuses amounts a skill plan could not have, and unknown tickers', async () => {
    const at = (query: string) => call(preflightRoute, { path: `/api/preflight?${query}` });
    expect((await at(`ticker=${bstocks.ticker}&usd=26`)).body).toMatchObject({
      error: { code: 'bad_amount' },
    });
    expect((await at(`ticker=${bstocks.ticker}&usd=0.1`)).status).toBe(400);
    expect((await at(`ticker=${bstocks.ticker}`)).body).toMatchObject({
      error: { code: 'bad_request' },
    });
    expect((await at(`ticker=${bstocks.ticker}&usd=5&window=always`)).status).toBe(400);
    expect((await at('ticker=QQQQQQ&usd=5')).status).toBe(404);
  });

  it('GET /api/projection: no rate, no projection; with the listed APY, the numbers and their age', async () => {
    const path = `/api/projection?depositUsd=1000&ticker=${bstocks.ticker}`;
    const none = await call<{ apy: { state: string }; projection: unknown }>(projectionRoute, {
      path,
    });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ apy: { state: 'UNAVAILABLE' }, projection: null });

    await writeWorkerStatus(db, 'venus', { apyDisplay: '3.16%', verifiedAt: ago(30) });
    type View = {
      apy: { pct: string; state: string; at: string };
      minBuyUsd: string;
      firstBuyUsd: string;
      price: { issuer: string; sharePriceUsd: string; venueMinUsd: string | null; state: string };
      projection: { perYearUsd: string; daysToFirstBuy: number; sharesPerMonth: string | null };
      assumption: string;
    };
    const live = await call<View>(projectionRoute, { path });
    expect(live.body.apy).toEqual({ pct: '3.16', state: 'LIVE', at: ago(30) });
    expect(live.body.minBuyUsd).toBe('0.25');
    expect(live.body.firstBuyUsd).toBe('0.25');
    expect(live.body.price).toMatchObject({
      issuer: 'bstocks',
      sharePriceUsd: '224.999900',
      venueMinUsd: null,
      state: 'LIVE',
    });
    expect(live.body.projection).toMatchObject({ perYearUsd: '31.600000', daysToFirstBuy: 3 });
    expect(Number(live.body.projection.sharesPerMonth)).toBeGreaterThan(0);
    expect(live.body.assumption).toBe('listed_apy_held_constant_compounded_daily');

    // Priced in the Ondo token, the first buy is Ondo's $5.01 minimum: 59 days, not 3.
    const ondoView = await call<View>(projectionRoute, { path: `${path}&issuer=ondo` });
    expect(ondoView.body.price).toMatchObject({ issuer: 'ondo', venueMinUsd: '5.01' });
    expect(ondoView.body.firstBuyUsd).toBe('5.01');
    expect(ondoView.body.projection.daysToFirstBuy).toBe(59);

    // Half an hour later the tape is STALE: its price is shown with that state, and no share
    // count is made from it.
    vi.setSystemTime(new Date(NOW.getTime() + 30 * 60_000));
    const old = await call<View>(projectionRoute, { path });
    expect(old.body.price.state).toBe('STALE');
    expect(old.body.projection.sharesPerMonth).toBeNull();
    expect(old.body.projection.perYearUsd).toBe('31.600000');
    vi.setSystemTime(NOW);

    await writeWorkerStatus(db, 'venus', { apyDisplay: '3.16%', verifiedAt: ago(13 * 60) });
    const stale = await call<{ apy: { state: string } }>(projectionRoute, { path });
    expect(stale.body.apy.state).toBe('STALE');

    expect((await call(projectionRoute, { path: '/api/projection?depositUsd=0' })).status).toBe(
      400,
    );
    expect((await call(projectionRoute, { path: '/api/projection?depositUsd=abc' })).status).toBe(
      400,
    );
    expect(
      (await call(projectionRoute, { path: '/api/projection?depositUsd=10&ticker=QQQQQQ' })).status,
    ).toBe(404);
    expect(
      (
        await call(projectionRoute, {
          path: '/api/projection?depositUsd=10&ticker=QQQQQQ&issuer=ondo',
        })
      ).body,
    ).toMatchObject({
      error: { code: 'unknown_ticker', message: 'QQQQQQ (ondo) is not in the registry' },
    });
  });

  describe('POST /api/mcp with the official MCP SDK client', () => {
    /** The SDK's HTTP calls, answered by the route; GET and DELETE get Next's 405 for unexported methods. */
    const fetchToRoute = async (url: string | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      return request.method === 'POST'
        ? mcpRoute(request)
        : new Response(null, { status: 405, headers: { Allow: 'POST' } });
    };

    async function connect() {
      const client = new Client({ name: 'yieldvest-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(
        new URL('http://localhost:3000/api/mcp'),
        {
          fetch: fetchToRoute,
        },
      );
      await client.connect(transport);
      return client;
    }

    it('initializes, lists read-only tools and calls them', async () => {
      await tick(ago(2));
      const client = await connect();
      try {
        expect(client.getServerVersion()).toMatchObject({ name: 'yieldvest', version: '1.0.0' });
        expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
        expect(client.getInstructions()).toContain('read-only');

        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'compare_issuers',
          'interest_projection',
          'market_status',
          'plan_status',
          'preflight',
          'recent_receipts',
        ]);
        expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

        const pre = await client.callTool({
          name: 'preflight',
          arguments: { ticker: bstocks.ticker, usd: 6, issuer: 'bstocks' },
        });
        expect(pre.isError).toBe(false);
        expect(pre.structuredContent).toMatchObject({
          ticker: bstocks.ticker,
          usd: '6',
          issuers: [{ issuer: 'bstocks', decision: 'buy', spendUsd: '6' }],
        });

        const compare = await client.callTool({
          name: 'compare_issuers',
          arguments: { ticker: bstocks.ticker },
        });
        expect(compare.structuredContent).toMatchObject({
          ticker: bstocks.ticker,
          data: { state: 'LIVE' },
        });

        const market = await client.callTool({ name: 'market_status', arguments: {} });
        expect(market.structuredContent).toMatchObject({
          session: 'regular',
          data: { state: 'LIVE' },
        });

        const receipts = await client.callTool({
          name: 'recent_receipts',
          arguments: { limit: 3 },
        });
        expect(receipts.isError).toBe(false);

        const missing = await client.callTool({
          name: 'plan_status',
          arguments: { planId: 'nope' },
        });
        expect(missing).toMatchObject({
          isError: true,
          content: [{ type: 'text', text: 'no such plan' }],
        });

        const bad = await client.callTool({
          name: 'interest_projection',
          arguments: { depositUsd: '-5' },
        });
        expect(bad.isError).toBe(true);

        await expect(client.callTool({ name: 'swap', arguments: {} })).rejects.toThrow(
          /unknown tool/,
        );
        await expect(client.ping()).resolves.toEqual({});
      } finally {
        await client.close();
      }
    });

    it('refuses another origin and an unknown protocol version', async () => {
      const post = (headers: Record<string, string>) =>
        mcpRoute(
          new Request('http://localhost:3000/api/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
          }),
        );
      expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
      expect((await post({ origin: 'http://localhost:3000' })).status).toBe(200);
      expect((await post({ 'mcp-protocol-version': '1999-01-01' })).status).toBe(400);
      expect((await post({ 'mcp-protocol-version': '2025-06-18' })).status).toBe(200);
      const notJson = await mcpRoute(
        new Request('http://localhost:3000/api/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{nope',
        }),
      );
      expect(notJson.status).toBe(400);
      expect(await notJson.json()).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700 },
      });
    });
  });
});
