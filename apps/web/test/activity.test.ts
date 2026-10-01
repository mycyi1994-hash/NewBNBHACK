/**
 * The reads behind the approved design's Overview, Earn and Activity tabs and the receipt page: the
 * activity feed (every cycle of Yieldvest's own plans, other plans' cycles only once they reached
 * the chain, lone deposits and redeems), totals, one cycle with its steps, a plan's history, and a
 * yield plan's interest story. Amounts come from the records, never from a quote.
 */
import { randomUUID } from 'node:crypto';
import {
  appendCycleStep,
  createDb,
  getPlan,
  insertPlan,
  openCycle,
  recordReceiptFacts,
  updateCycle,
  type InstrumentRow,
  type PlanInsert,
} from '@yieldvest/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activityFeed,
  activityTotals,
  cycleDetail,
  interestStory,
  planActivity,
  receiptUsd,
} from '../lib/server/activity';
import type { HousePlan } from '../lib/server/house';
import { interestNow } from '../lib/server/overview';
import { webTestUrl } from './db';
import { cleanup, randomHash, testInstrument } from './harness';

const E18 = '000000000000000000';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('receiptUsd', () => {
  it('reads the USDT a receipt moved from its Transfer logs first, the requested amount after', () => {
    expect(receiptUsd('swap', { spentUsdtUnits: `5${E18}`, receivedTokens: '1' })).toBe('5');
    expect(receiptUsd('deposit', { amountUsd: '1', usdtSpent: '999999999999999999' })).toBe(
      '0.999999999999999999',
    );
    expect(receiptUsd('redeem', { usdtReceived: '280000000000000000', reason: 'x' })).toBe('0.28');
    expect(receiptUsd('deposit', { amountUsd: '1000' })).toBe('1000');
    expect(receiptUsd('approve', { spentUsdtUnits: `5${E18}` })).toBeNull();
    expect(receiptUsd('swap', {})).toBeNull();
    expect(receiptUsd('swap', null)).toBeNull();
  });
});

describe('interestNow', () => {
  const plan = (interest: HousePlan['interest'], carried = '0.03') =>
    ({ harvestedUnspentUsd: carried, interest }) as HousePlan;

  it('adds the interest in the position to what was carried forward, as decideCycle does', () => {
    const now = interestNow(
      plan({ state: 'LIVE', usd: '0.151234', asOf: '2026-09-27T10:00:00.000Z' }),
    );
    expect(now).toMatchObject({
      state: 'LIVE',
      inPositionUsd: '0.151234',
      carriedUsd: '0.03',
      availableUsd: '0.181234',
      asOf: '2026-09-27T10:00:00.000Z',
    });
  });

  it('never makes up a number the chain did not give', () => {
    expect(
      interestNow(plan({ state: 'UNAVAILABLE', usd: null, reason: 'no principal deposited yet' })),
    ).toMatchObject({
      state: 'UNAVAILABLE',
      availableUsd: null,
      inPositionUsd: null,
      reason: 'no principal deposited yet',
    });
    expect(interestNow(null)).toMatchObject({ state: 'UNAVAILABLE', reason: 'no yield plan' });
  });
});

describe.skipIf(!webTestUrl)('activity reads', () => {
  const { db, close } = createDb(webTestUrl ?? 'postgres://unused');
  const planIds: string[] = [];
  let instrument: InstrumentRow;

  beforeAll(async () => {
    instrument = await testInstrument(db);
  });
  afterAll(async () => {
    await cleanup(db, { planIds, instrumentIds: [instrument.id] });
    await close();
  });

  async function plan(overrides: Partial<PlanInsert> = {}) {
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

  const receipt = (
    planId: string,
    cycleId: number | null,
    kind: 'approve' | 'swap' | 'deposit' | 'redeem',
    amounts: Record<string, string> = {},
  ) =>
    recordReceiptFacts(db, planId, cycleId, {
      kind,
      txHash: randomHash(),
      broadcastVia: 'transaction_api',
      blockNumber: 62_000_000n,
      status: 'success',
      amounts,
    });

  async function bought(
    planId: string,
    dueAt: string,
    spendUsd: string,
    interestUsd: string | null,
  ) {
    const { cycle } = await openCycle(db, { planId, dueAt, executionMode: 'live' });
    await receipt(planId, cycle.id, 'approve');
    await receipt(planId, cycle.id, 'swap', {
      instrumentId: instrument.id,
      spentUsdtUnits: `${spendUsd}${E18}`,
      receivedTokens: '22212154002358265',
    });
    await updateCycle(db, cycle.id, {
      state: 'done',
      outcomeKind: 'BOUGHT',
      outcome: {
        kind: 'BOUGHT',
        spendUsd,
        tokens: '22212154002358265',
        shares: '0.022194',
        interestUsd,
        refGapPct: null,
      },
      whyKey: interestUsd ? 'why.bought.interest' : 'why.bought.regular',
      whyParams: { ticker: instrument.ticker, shares: '0.022194', usd: spendUsd },
      instrumentId: instrument.id,
      spendUsd,
      interestUsd,
      finishedAt: new Date().toISOString(),
    });
    return cycle.id;
  }

  it('shows every cycle of a house plan, other plans only on-chain, and lone receipts', async () => {
    const house = await plan();
    const buy = await bought(house, minutesAgo(30), '5', null);
    const { cycle: waited } = await openCycle(db, {
      planId: house,
      dueAt: minutesAgo(20),
      executionMode: 'live',
    });
    await updateCycle(db, waited.id, {
      state: 'done',
      outcomeKind: 'DEFERRED',
      outcome: { kind: 'DEFERRED', reason: 'market_closed', retryAt: '2026-09-28T13:32:00.000Z' },
      whyKey: 'why.deferred.market_closed',
      whyParams: { open: '2026-09-28T13:32:00.000Z' },
      finishedAt: new Date().toISOString(),
    });
    // A deposit's exact approval goes just before it, outside any cycle: one entry, not two.
    await receipt(house, null, 'approve');
    await receipt(house, null, 'deposit', { amountUsd: '10', usdtSpent: `10${E18}` });

    const judge = await plan({ ownerKind: 'judge', ownerRef: `code-${randomUUID()}` });
    const { cycle: dryRun } = await openCycle(db, {
      planId: judge,
      dueAt: minutesAgo(15),
      executionMode: 'simulate',
    });
    await updateCycle(db, dryRun.id, {
      state: 'done',
      outcome: { kind: 'SIMULATED', spendUsd: '5', expectedShares: '0.0222' },
      spendUsd: '5',
      finishedAt: new Date().toISOString(),
    });
    const judgeBuy = await bought(judge, minutesAgo(10), '2.5', null);

    const feed = await activityFeed(db, 500);
    const mine = feed.filter((item) => item.plan && [house, judge].includes(item.plan.id));
    expect(mine.map((item) => item.key)).toEqual([
      `cycle-${judgeBuy}`,
      expect.stringMatching(/^tx-0x/),
      `cycle-${waited.id}`,
      `cycle-${buy}`,
    ]);
    const [judgeRow, deposit, wait, houseBuy] = mine;
    expect(houseBuy).toMatchObject({
      cycleId: buy,
      kind: 'BOUGHT',
      executionMode: 'live',
      spendUsd: '5',
      shares: '0.022194',
      interestUsd: null,
      why: { key: 'why.bought.regular' },
      plan: { id: house, owner: 'house', mode: 'safe', ticker: instrument.ticker },
    });
    expect(houseBuy?.receipts.map((r) => [r.kind, r.usd])).toEqual([
      ['approve', null],
      ['swap', '5'],
    ]);
    expect(houseBuy?.receipts[1]?.explorerUrl).toMatch(/^https:\/\/bscscan\.com\/tx\/0x/);
    expect(wait).toMatchObject({ kind: 'DEFERRED', spendUsd: null, receipts: [] });
    expect(deposit).toMatchObject({ kind: 'deposit', cycleId: null, spendUsd: '10' });
    expect(deposit?.receipts.map((r) => [r.kind, r.usd])).toEqual([
      ['approve', null],
      ['deposit', '10'],
    ]);
    expect(judgeRow).toMatchObject({ kind: 'BOUGHT', spendUsd: '2.5', plan: { owner: 'judge' } });
    // A judge's dry run reached nothing on chain: it is not in the public feed.
    expect(feed.some((item) => item.cycleId === dryRun.id)).toBe(false);

    // The judge's own plan page lists it, with what it would have received.
    const history = await planActivity(db, await getRow(judge));
    expect(history.map((item) => [item.kind, item.shares])).toEqual([
      ['BOUGHT', '0.022194'],
      ['SIMULATED', '0.0222'],
    ]);
    // An approval whose deposit never came stays its own entry, as what it is.
    await receipt(judge, null, 'approve');
    const after = await planActivity(db, await getRow(judge));
    expect(after.map((item) => item.kind)).toEqual(['approve', 'BOUGHT', 'SIMULATED']);
  });

  async function getRow(id: string) {
    const row = await getPlan(db, id);
    if (!row) throw new Error(`plan ${id} missing`);
    return row;
  }

  it('counts every recorded buy and receipt', async () => {
    const before = await activityTotals(db);
    const house = await plan();
    await bought(house, minutesAgo(5), '5', null);
    const after = await activityTotals(db);
    expect(after.purchases - before.purchases).toBe(1);
    expect(Number(after.boughtUsd) - Number(before.boughtUsd)).toBeCloseTo(5, 10);
    expect(after.receipts - before.receipts).toBe(2);
    expect(after.lastPurchaseAt).not.toBeNull();
  });

  it('reads one cycle with its plan, receipts and step log', async () => {
    const house = await plan();
    const id = await bought(house, minutesAgo(4), '5', null);
    await appendCycleStep(db, id, { step: 'INPUTS', mode: 'live', markets: [] });
    await appendCycleStep(db, id, { step: 'BOUGHT', received: '1' });
    const detail = await cycleDetail(db, id);
    expect(detail?.item).toMatchObject({ cycleId: id, kind: 'BOUGHT', plan: { id: house } });
    expect(detail?.item.receipts).toHaveLength(2);
    expect(detail?.steps.map((s) => s.step)).toEqual(['INPUTS', 'BOUGHT']);
    expect(detail?.finishedAt).not.toBeNull();
    expect(await cycleDetail(db, 2_000_000_000)).toBeUndefined();

    // Another owner's cycle that left nothing on chain is not public, even by its id.
    const judge = await plan({ ownerKind: 'judge', ownerRef: `code-${randomUUID()}` });
    const { cycle: dryRun } = await openCycle(db, {
      planId: judge,
      dueAt: minutesAgo(3),
      executionMode: 'simulate',
    });
    expect(await cycleDetail(db, dryRun.id)).toBeUndefined();
    const judgeBuy = await bought(judge, minutesAgo(2), '2.5', null);
    expect((await cycleDetail(db, judgeBuy))?.item.plan?.owner).toBe('judge');
  });

  it("tells a yield plan's interest story from its own records", async () => {
    const yieldPlan = await plan({
      mode: 'yield',
      contributionUsd: '0',
      principalUsd: '1000',
      vtokenUnits: '5000000000',
      cadence: 'weekly',
    });
    const empty = await interestStory(db, yieldPlan);
    expect(empty).toEqual({
      spentUsd: '0',
      purchases: 0,
      since: null,
      cycleStart: null,
      lastBuyCycleId: null,
    });

    await receipt(yieldPlan, null, 'deposit', { amountUsd: '1000', usdtSpent: `1000${E18}` });
    const first = await bought(yieldPlan, minutesAgo(3), '0.28', '0.28');
    await receipt(yieldPlan, first, 'redeem', { usdtReceived: '280000000000000000' });
    const second = await bought(yieldPlan, minutesAgo(2), '0.30', '0.25');
    const story = await interestStory(db, yieldPlan);
    expect(story.spentUsd).toBe('0.53');
    expect(story.purchases).toBe(2);
    expect(story.lastBuyCycleId).toBe(second);
    expect(story.since).not.toBeNull();
    // The latest deposit or redeem resets what the position holds above principal.
    expect(story.cycleStart && story.since && story.cycleStart > story.since).toBe(true);
  });
});
