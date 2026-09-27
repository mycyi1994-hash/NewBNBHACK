/**
 * runCycle end to end (M1-03/M1-04): real Postgres, a fake Binance API with fixture-shaped
 * answers, and an in-memory chain. Live mode signs with a public test key and "broadcasts" into
 * the fake chain only — nothing here reaches a network.
 */
import {
  createDb,
  getCycle,
  getHolding,
  getPlan,
  listGuardianEvents,
  listReceipts,
  txOutbox,
  upsertHolding,
} from '@yieldvest/db';
import { sharesFromTokens } from '@yieldvest/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTestUrl } from '../test/db.js';
import { cleanup, HOUSE, ROUTER } from '../test/harness.js';
import { createWorld, RECEIVED, testInstrument, testPlan, USDT } from '../test/world.js';
import { runCycle } from './cycle.js';

const url = agentTestUrl;
const MON_1000 = '2026-09-28T14:00:00.000Z'; // Mon 10:00 ET, regular session
const SATURDAY = '2026-09-26T15:00:00.000Z';

describe.skipIf(!url)('runCycle on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const planIds: string[] = [];
  let ticker = '';
  let instrumentId = '';

  beforeAll(async () => {
    ({ ticker, instrumentId } = await testInstrument(db));
  });
  afterAll(async () => {
    await cleanup(db, planIds, [instrumentId]);
    await close();
  });

  async function plan(overrides: Record<string, unknown> = {}) {
    const id = await testPlan(db, ticker, overrides);
    planIds.push(id);
    return id;
  }

  const world = (start: string, opts: { exactApprove?: boolean } = {}) =>
    createWorld(db, start, opts);

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

  it('live: a buy on top of a holding written at another multiplier logs the change and recomputes shares (M1-08)', async () => {
    const id = await plan();
    // 1 token held since the multiplier was 1.0 (e.g. before a dividend adjustment).
    await upsertHolding(db, {
      planId: id,
      instrumentId,
      tokens: (10n ** 18n).toString(),
      decimals: 18,
      multiplierAtLastUpdate: '1',
      shares: '1',
      costUsd: '225',
    });
    const w = await world(MON_1000);
    expect(await runCycle(w.deps('live'), id)).toMatchObject({ outcome: { kind: 'BOUGHT' } });
    const events = await listGuardianEvents(db, { planId: id });
    expect(events).toMatchObject([
      {
        rule: 'multiplier_changed',
        action: 'warn',
        detail: { from: '1', to: '1.000778223752807865' },
      },
    ]);
    const holding = await getHolding(db, id, instrumentId);
    expect(holding?.tokens).toBe((10n ** 18n + RECEIVED).toString());
    // Shares = all tokens × the current multiplier, not the old one.
    expect(holding?.multiplierAtLastUpdate).toBe('1.000778223752807865');
    expect(holding?.shares).toBe(
      sharesFromTokens(10n ** 18n + RECEIVED, 18, '1.000778223752807865'),
    );
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

  it('live: a swap that calls anything but the approved router is never signed', async () => {
    const id = await plan();
    const w = await world(MON_1000);
    const swap = w.api.routes['/api/v1/dex/aggregator/swap'];
    w.api.routes['/api/v1/dex/aggregator/swap'] = (u, body) => {
      const built = swap?.(u, body) as { tx: Record<string, unknown> };
      return { ...built, tx: { ...built.tx, to: '0x000000000000000000000000000000000000bEEF' } };
    };
    const report = await runCycle(w.deps('live'), id);
    // The approval went out first, so its gas was spent: the why says so.
    expect(report).toMatchObject({
      status: 'done',
      outcome: { kind: 'FAILED', code: 'SWAP_TARGET_MISMATCH', fundsMoved: 'gas_only' },
      why: { key: 'why.failed.onchain', params: { code: 'SWAP_TARGET_MISMATCH' } },
    });
    expect(w.chain.sent.map((tx) => tx.data.slice(0, 10))).toEqual(['0x095ea7b3']);
    expect(w.api.calls.filter((c) => c.endsWith('/broadcast-transaction'))).toHaveLength(1);
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
