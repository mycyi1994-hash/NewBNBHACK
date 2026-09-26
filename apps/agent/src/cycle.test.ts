/**
 * runCycle end to end (M1-03/M1-04): real Postgres, a fake Binance API with fixture-shaped
 * answers, and an in-memory chain. Live mode signs with a public test key and "broadcasts" into
 * the fake chain only — nothing here reaches a network.
 */
import { randomUUID } from 'node:crypto';
import { encodeApprove } from '@ijaro/chain';
import { parseConfig } from '@ijaro/config';
import {
  createDb,
  getCycle,
  getHolding,
  getPlan,
  insertPlan,
  lastOutboxNonce,
  listReceipts,
  txOutbox,
  upsertInstruments,
  type InstrumentRow,
} from '@ijaro/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  fakeApi,
  fakeChain,
  HOUSE,
  ROUTER,
  signer,
  testClock,
  TOKEN,
  transferLog,
  type FakeApi,
  type FakeChain,
} from '../test/harness.js';
import { createAlerter } from './alerts.js';
import { runCycle, type CycleDeps } from './cycle.js';

const url = process.env.IJARO_TEST_DATABASE_URL;
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const MON_1000 = '2026-09-28T14:00:00.000Z'; // Mon 10:00 ET, regular session
const SATURDAY = '2026-09-26T15:00:00.000Z';
const RECEIVED = 22_212_154_002_358_266n; // tokens for $5 at ~$225

describe.skipIf(!url)('runCycle on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const ticker = `T${randomUUID().slice(0, 6).toUpperCase()}`;
  const instrumentId = `${ticker}:bstocks`;
  const planIds: string[] = [];
  const config = parseConfig({});

  beforeAll(async () => {
    const row: InstrumentRow = {
      id: instrumentId,
      ticker,
      issuer: 'bstocks',
      platformId: 'bstock',
      chainId: 56,
      address: TOKEN,
      symbol: `${ticker}B`,
      decimals: 18,
      assetType: 1,
      multiplier: '1.000778223752807865',
      multiplierSource: 'onchain',
      apiShareRatio: '1.000778223752807865',
      verifiedAt: '2026-09-24T00:45:40.000Z',
    };
    await upsertInstruments(db, [row]);
  });
  afterAll(async () => {
    await cleanup(db, planIds, [instrumentId]);
    await close();
  });

  async function plan(overrides: Record<string, unknown> = {}) {
    const id = `T-${randomUUID()}`;
    planIds.push(id);
    await insertPlan(db, {
      id,
      ownerKind: 'house',
      mode: 'safe',
      ticker,
      issuerPreference: ['bstocks', 'ondo'],
      contributionUsd: '5',
      cadence: 'daily',
      window: 'regular_session',
      maxPerBuyUsd: '5',
      maxDailyUsd: '5',
      status: 'active',
      nextDueAt: '2026-09-28T13:32:00.000Z',
      ...overrides,
    });
    return id;
  }

  /** A fake API that answers like the recorded fixtures; the chain decides the simulations. */
  async function world(start: string, opts: { exactApprove?: boolean } = {}) {
    const clock = testClock(start);
    const last = await lastOutboxNonce(db, 56, HOUSE);
    const chain: FakeChain = fakeChain(last === undefined ? 0 : last + 1);
    chain.onMine = (tx) =>
      tx.to.toLowerCase() === ROUTER.toLowerCase()
        ? {
            status: 'success',
            logs: [
              transferLog(USDT, HOUSE, ROUTER, 5n * 10n ** 18n),
              transferLog(TOKEN, ROUTER, HOUSE, RECEIVED),
            ],
          }
        : { status: 'success', logs: [] };
    const allowance = () => chain.allowances.get(`${USDT}:${HOUSE}:${ROUTER}`.toLowerCase()) ?? 0n;
    const api: FakeApi = fakeApi(clock, {
      '/api/v1/dex/market/rwa/tokens': () => [
        {
          tokenContractAddress: TOKEN,
          statusInfo: {
            openState: true,
            marketStatus: null,
            reasonCode: 'TRADING',
            reasonMsg: null,
          },
        },
      ],
      '/api/v1/dex/market/rwa/price': () => [
        {
          tokenContractAddress: TOKEN,
          tokenPrice: '225.2',
          referencePrice: '225.02',
          tokenPriceUpdatedAt: 0,
        },
      ],
      '/api/v1/dex/aggregator/quote': (u) => [
        {
          quoteId: `q-${clock.now()}`,
          vendorName: 'LiquidMesh',
          executionMode: 'SWAP',
          fromTokenAmount: u.searchParams.get('amount'),
          toTokenAmount: RECEIVED.toString(),
          priceImpactPercent: '0.0000000000',
          approveTarget: ROUTER,
          isBest: true,
        },
      ],
      '/api/v1/dex/aggregator/approve-transaction': (u) => {
        const amount = BigInt(u.searchParams.get('approveAmount') ?? '0');
        return [
          {
            data: encodeApprove(ROUTER, opts.exactApprove === false ? 2n ** 256n - 1n : amount),
            dexContractAddress: ROUTER,
            gasLimit: '63448',
            gasPrice: '58339710',
          },
        ];
      },
      '/api/v1/dex/aggregator/swap': (u) => ({
        tx: {
          from: u.searchParams.get('userWalletAddress'),
          to: ROUTER,
          data: '0xad43f73d',
          value: '0',
          gas: '450000',
          gasPrice: '58339710',
          maxPriorityFeePerGas: '58339710',
          minReceiveAmount: '22101093232346474',
        },
        executionMode: 'SWAP',
        rfq: null,
      }),
      '/api/v1/dex/pre-transaction/simulate': (_u, body) => {
        const call = (body as { evmTx: { to: string; data: string } }).evmTx;
        if (call.data.startsWith('0x095ea7b3')) {
          return { status: 'SUCCESS', failReason: '', balanceChanges: [], allowanceChanges: [] };
        }
        return allowance() >= 5n * 10n ** 18n
          ? { status: 'SUCCESS', failReason: '', balanceChanges: [], allowanceChanges: [] }
          : {
              status: 'FAILED',
              failReason: 'execution reverted: BEP20: transfer amount exceeds allowance',
              balanceChanges: [],
              allowanceChanges: [],
            };
      },
      '/api/v1/dex/pre-transaction/broadcast-transaction': (_u, body) => {
        const raw = (body as { signedTransaction: `0x${string}` }).signedTransaction;
        return { txHash: chain.accept(raw), orderId: 'o-1' };
      },
    });
    const lines: string[] = [];
    const alerts: string[] = [];
    const deps = (mode: 'simulate' | 'live'): CycleDeps => ({
      mode,
      client: api.client,
      chain,
      db,
      house: HOUSE,
      ...(mode === 'live' ? { signer } : {}),
      log: (line) => lines.push(line),
      now: () => new Date(clock.now()),
      config,
      alerter: createAlerter({ log: (line) => alerts.push(line) }),
      stockQuote: () => Promise.resolve({ ok: true, stockPrice: '225.00' }),
    });
    return { clock, chain, api, deps, lines, alerts };
  }

  it('simulate: approval simulated, swap simulated and refused for allowance, nothing signed (G3-3)', async () => {
    const id = await plan({ status: 'paused', pausedReason: 'awaiting_funding' });
    const w = await world(MON_1000);
    const report = await runCycle(w.deps('simulate'), id, { manual: true });
    expect(report).toMatchObject({
      status: 'simulated',
      buy: {
        instrumentId,
        spendUsd: '5',
        expectedTokens: RECEIVED.toString(),
        approval: 'simulated',
        swapSimulation: {
          status: 'FAILED',
          failReason: 'execution reverted: BEP20: transfer amount exceeds allowance',
        },
      },
    });
    expect(w.api.calls).toEqual([
      '/api/v1/dex/market/rwa/tokens',
      '/api/v1/dex/market/rwa/price',
      '/api/v1/dex/aggregator/quote',
      '/api/v1/dex/aggregator/approve-transaction',
      '/api/v1/dex/pre-transaction/simulate',
      '/api/v1/dex/aggregator/swap',
      '/api/v1/dex/pre-transaction/simulate',
    ]);
    expect(w.chain.sent).toEqual([]);
    const stored = await getPlan(db, id);
    expect(stored?.status).toBe('paused');
    expect(stored?.nextDueAt).toMatch(/^2026-09-28 13:32/);
    if (report.status !== 'simulated') throw new Error('not simulated');
    expect(await getCycle(db, report.cycleId)).toMatchObject({
      state: 'done',
      executionMode: 'simulate',
      outcomeKind: null,
    });
    expect(await db.select().from(txOutbox).where(eq(txOutbox.planId, id))).toEqual([]);
  });

  it('live: exact approve → receipt → swap → receipt → BOUGHT, with receipts, holding and ledger', async () => {
    const id = await plan();
    const w = await world(MON_1000);
    const report = await runCycle(w.deps('live'), id);
    expect(report).toMatchObject({
      status: 'done',
      outcome: { kind: 'BOUGHT', spendUsd: '5', tokens: RECEIVED.toString(), interestUsd: null },
      why: { key: 'why.bought.regular', params: { ticker, usd: '5.00' } },
    });
    expect(w.api.calls).toEqual([
      '/api/v1/dex/market/rwa/tokens',
      '/api/v1/dex/market/rwa/price',
      '/api/v1/dex/aggregator/quote',
      '/api/v1/dex/aggregator/approve-transaction',
      '/api/v1/dex/pre-transaction/simulate',
      '/api/v1/dex/pre-transaction/broadcast-transaction',
      '/api/v1/dex/aggregator/swap',
      '/api/v1/dex/pre-transaction/simulate',
      '/api/v1/dex/pre-transaction/broadcast-transaction',
    ]);
    // The approval is exactly the spend, to the spender the API named.
    expect(w.chain.allowances.get(`${USDT}:${HOUSE}:${ROUTER}`.toLowerCase())).toBe(
      5n * 10n ** 18n,
    );
    const [first, second] = w.chain.sent.map((tx) => tx.nonce);
    expect(second).toBe((first ?? -2) + 1);
    const rows = await listReceipts(db, { planIds: [id] });
    expect(rows.map((r) => [r.kind, r.broadcastVia, r.status]).sort()).toEqual([
      ['approve', 'transaction_api', 'success'],
      ['swap', 'transaction_api', 'success'],
    ]);
    expect(rows.every((r) => r.explorerUrl === `https://bscscan.com/tx/${r.txHash}`)).toBe(true);
    const holding = await getHolding(db, id, instrumentId);
    expect(holding).toMatchObject({
      tokens: RECEIVED.toString(),
      multiplierAtLastUpdate: '1.000778223752807865',
    });
    const outbox = await db.select().from(txOutbox).where(eq(txOutbox.planId, id));
    expect(outbox.map((r) => r.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
    // A scheduled run moves the plan to the next regular open + 2 min.
    expect((await getPlan(db, id))?.nextDueAt).toMatch(/^2026-09-29 13:32/);
    expect(w.alerts).toEqual([]);
  });

  it('live: an unlimited approval from the API is refused before anything is signed', async () => {
    const id = await plan();
    const w = await world(MON_1000, { exactApprove: false });
    const report = await runCycle(w.deps('live'), id);
    expect(report).toMatchObject({
      status: 'done',
      outcome: { kind: 'FAILED', code: 'APPROVE_NOT_EXACT', fundsMoved: 'none' },
      why: { key: 'why.failed.simulation', params: { code: 'APPROVE_NOT_EXACT' } },
    });
    expect(w.chain.sent).toEqual([]);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]).toContain('APPROVE_NOT_EXACT');
  });

  it('live: on Saturday the cycle defers to Monday 09:32 ET without a single quote', async () => {
    const id = await plan({ nextDueAt: '2026-09-26T13:32:00.000Z' });
    const w = await world(SATURDAY);
    const report = await runCycle(w.deps('live'), id);
    expect(report).toMatchObject({
      status: 'done',
      outcome: { kind: 'DEFERRED', reason: 'market_closed', retryAt: '2026-09-28T13:32:00.000Z' },
      why: { key: 'why.deferred.market_closed' },
    });
    expect(w.api.calls.filter((c) => c.includes('aggregator'))).toEqual([]);
    expect((await getPlan(db, id))?.nextDueAt).toMatch(/^2026-09-28 13:32/);
    // Due again only then; an earlier tick does nothing.
    expect(await runCycle(w.deps('live'), id)).toEqual({ status: 'not_due', planId: id });
  });

  it('live: falls back to RPC when the Transaction API cannot broadcast (40431)', async () => {
    const id = await plan();
    const w = await world(MON_1000);
    w.api.routes['/api/v1/dex/pre-transaction/broadcast-transaction'] = () => ({
      code: 40431,
      msg: 'Transaction broadcast failed, please check gas settings and retry',
    });
    const report = await runCycle(w.deps('live'), id);
    expect(report).toMatchObject({ status: 'done', outcome: { kind: 'BOUGHT' } });
    const rows = await listReceipts(db, { planIds: [id] });
    expect(rows.map((r) => r.broadcastVia)).toEqual(['rpc', 'rpc']);
  });

  it('live: a receipt that does not arrive leaves the cycle awaiting and blocks new signing', async () => {
    const id = await plan();
    const w = await world(MON_1000);
    w.chain.mines = false;
    const report = await runCycle(w.deps('live'), id);
    expect(report).toMatchObject({ status: 'awaiting_tx' });
    const outbox = await db.select().from(txOutbox).where(eq(txOutbox.planId, id));
    expect(outbox.map((r) => [r.kind, r.status])).toEqual([['approve', 'PENDING']]);
    // The next tick settles the outbox first; while it is pending, nothing new is signed.
    const other = await plan();
    expect(await runCycle(w.deps('live'), other)).toMatchObject({ status: 'outbox_busy' });
    // Once mined, reconciliation confirms it and the other plan can buy.
    w.chain.mines = true;
    const next = await runCycle(w.deps('live'), other);
    expect(next).toMatchObject({ status: 'done', outcome: { kind: 'BOUGHT' } });
  });
});
