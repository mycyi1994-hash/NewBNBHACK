/**
 * Plans, cycles, receipts, holdings and guardian events on Postgres: the seed, the scheduler lock,
 * cycle idempotency and the money CHECK constraints (M1-01).
 */
import { randomBytes } from 'node:crypto';
import { inArray, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deletePlans,
  newCycle,
  testPlan,
  testDatabaseUrl as url,
  violatedConstraint,
} from '../test/helpers.js';
import {
  acquirePlanLock,
  appendCycleStep,
  createDb,
  cyclesAwaitingTx,
  duePlans,
  getCycle,
  getHolding,
  getPlan,
  guardianEvents,
  holdingFromRow,
  housePlans,
  insertGuardianEvent,
  insertPlan,
  insertReceipt,
  listCycles,
  listGuardianEvents,
  listHoldings,
  listPlans,
  listReceipts,
  openCycle,
  planFromRow,
  plans,
  releasePlanLock,
  renewPlanLock,
  resolveGuardianEvents,
  seedHousePlans,
  updateCycle,
  updatePlan,
  upsertHolding,
} from './index.js';

const txHash = () => `0x${randomBytes(32).toString('hex')}`;

describe('house plans (SPEC §5.10, D-10)', () => {
  it('are NVDA safe $5 daily and QQQ yield weekly, regular session, paused until funded', () => {
    const [safe, yieldPlan] = housePlans('2026-09-28T13:32:00.000Z');
    expect(safe).toMatchObject({
      id: 'H-SAFE',
      ownerKind: 'house',
      mode: 'safe',
      ticker: 'NVDA',
      contributionUsd: '5',
      cadence: 'daily',
      window: 'regular_session',
      maxPerBuyUsd: '5',
      issuerPreference: ['bstocks', 'ondo'],
      status: 'paused',
      pausedReason: 'awaiting_funding',
    });
    expect(yieldPlan).toMatchObject({
      id: 'H-YIELD',
      mode: 'yield',
      ticker: 'QQQ',
      contributionUsd: '0',
      principalUsd: '0',
      cadence: 'weekly',
      window: 'regular_session',
      status: 'paused',
    });
  });
});

describe.skipIf(!url)('plans on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const created: string[] = [];

  afterAll(async () => {
    await deletePlans(db, created);
    await close();
  });

  async function plan(overrides: Parameters<typeof testPlan>[0] = {}) {
    const row = await insertPlan(db, testPlan(overrides));
    created.push(row.id);
    return row;
  }

  it('seeds the house plans once and never overwrites them', async () => {
    const due = '2026-09-28T13:32:00.000Z';
    const first = await seedHousePlans(db, due);
    created.push(...first.created);
    expect([...first.created, ...first.kept].sort()).toEqual(['H-SAFE', 'H-YIELD']);
    const before = await getPlan(db, 'H-SAFE');

    await updatePlan(db, 'H-SAFE', { nextDueAt: '2026-10-01T13:32:00.000Z' });
    expect(await seedHousePlans(db, due)).toEqual({ created: [], kept: ['H-SAFE', 'H-YIELD'] });
    expect((await getPlan(db, 'H-SAFE'))?.nextDueAt).toMatch(/^2026-10-01/);

    const safe = await getPlan(db, 'H-SAFE');
    if (!safe) throw new Error('H-SAFE missing');
    expect(planFromRow(safe)).toMatchObject({
      id: 'H-SAFE',
      owner: { kind: 'house' },
      mode: 'safe',
      target: { type: 'ticker', ticker: 'NVDA' },
      principalUsd: '0',
      contributionUsd: '5',
      limits: { maxPerBuyUsd: '5', maxDailyUsd: '5' },
      status: 'paused',
      pausedReason: 'awaiting_funding',
      nextDueAt: '2026-10-01T13:32:00.000Z',
    });
    if (before) await updatePlan(db, 'H-SAFE', { nextDueAt: before.nextDueAt });
  });

  it('refuses an active yield plan without principal, and other impossible money rows', async () => {
    const yieldPlan = await plan({ mode: 'yield', status: 'paused', contributionUsd: '0' });
    expect(await violatedConstraint(updatePlan(db, yieldPlan.id, { status: 'active' }))).toBe(
      'plans_yield_principal_ck',
    );
    await updatePlan(db, yieldPlan.id, { principalUsd: '100', status: 'active' });
    expect(planFromRow((await getPlan(db, yieldPlan.id))!)).toMatchObject({
      status: 'active',
      principalUsd: '100',
    });

    expect(
      await violatedConstraint(insertPlan(db, testPlan({ maxPerBuyUsd: '5', maxDailyUsd: '4' }))),
    ).toBe('plans_amounts_ck');
    expect(await violatedConstraint(insertPlan(db, testPlan({ contributionUsd: '-1' })))).toBe(
      'plans_amounts_ck',
    );
    expect(await violatedConstraint(insertPlan(db, testPlan({ mode: 'margin' })))).toBe(
      'plans_mode_ck',
    );
    expect(await violatedConstraint(insertPlan(db, testPlan({ ownerKind: 'anyone' })))).toBe(
      'plans_owner_kind_ck',
    );
  });

  it('keeps money exact to 18 decimals', async () => {
    const p = await plan({ contributionUsd: '0.123456789012345678' });
    expect(planFromRow((await getPlan(db, p.id))!).contributionUsd).toBe('0.123456789012345678');
  });

  it('lists due plans and gives the scheduler lock to exactly one holder', async () => {
    const now = new Date('2026-09-28T14:00:00.000Z');
    const due = await plan({ status: 'active', nextDueAt: '2026-09-28T13:32:00.000Z' });
    const later = await plan({ status: 'active', nextDueAt: '2026-09-28T15:00:00.000Z' });
    const paused = await plan({ status: 'paused', nextDueAt: '2026-09-28T13:32:00.000Z' });
    const ids = (await duePlans(db, now)).map((p) => p.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(later.id);
    expect(ids).not.toContain(paused.id);

    const holders = await Promise.all(
      Array.from({ length: 5 }, () => acquirePlanLock(db, due.id, now, 60_000)),
    );
    expect(holders.filter((h) => h !== undefined)).toHaveLength(1);
    expect((await duePlans(db, now)).map((p) => p.id)).not.toContain(due.id);
    expect(
      await acquirePlanLock(db, due.id, new Date(now.getTime() + 59_000), 60_000),
    ).toBeUndefined();

    // A holder that died: the lock expires and the next tick takes it.
    const dead = holders.find((h) => h !== undefined);
    const afterExpiry = new Date(now.getTime() + 61_000);
    const next = await acquirePlanLock(db, due.id, afterExpiry, 60_000);
    expect(next).toBeDefined();
    // The dead holder's late release changes nothing: the lock is no longer its own.
    expect(await releasePlanLock(db, due.id, dead?.lockUntil ?? null, { status: 'stopped' })).toBe(
      false,
    );
    expect((await getPlan(db, due.id))?.status).toBe('active');
    expect(
      await releasePlanLock(db, due.id, next?.lockUntil ?? null, {
        nextDueAt: '2026-09-29T13:32:00.000Z',
      }),
    ).toBe(true);
    const released = await getPlan(db, due.id);
    expect(released?.lockUntil).toBeNull();
    expect(released?.nextDueAt).toMatch(/^2026-09-29/);
  });

  it('renews a lock only for its holder, even after it lapsed, never after a takeover', async () => {
    const now = new Date('2026-09-28T14:00:00.000Z');
    const p = await plan({ status: 'active', nextDueAt: '2026-09-28T13:32:00.000Z' });
    const held = await acquirePlanLock(db, p.id, now, 60_000);
    const first = held?.lockUntil ?? '';
    // Lapsed, nobody took it: the holder keeps it, for another TTL from now.
    const late = new Date(now.getTime() + 90_000);
    const renewed = await renewPlanLock(db, p.id, first, late, 60_000);
    expect(Date.parse(renewed ?? '')).toBe(late.getTime() + 60_000);
    // A stale value (the one before the renewal) renews nothing.
    expect(await renewPlanLock(db, p.id, first, late, 60_000)).toBeUndefined();
    // Taken over after it lapsed: the old holder can neither renew nor release it.
    const takeover = new Date(late.getTime() + 61_000);
    const next = await acquirePlanLock(db, p.id, takeover, 60_000);
    expect(next).toBeDefined();
    expect(await renewPlanLock(db, p.id, renewed ?? '', takeover, 60_000)).toBeUndefined();
    expect(await releasePlanLock(db, p.id, renewed ?? null)).toBe(false);
    // Released: nobody's to renew.
    expect(await releasePlanLock(db, p.id, next?.lockUntil ?? null)).toBe(true);
    expect(await renewPlanLock(db, p.id, next?.lockUntil ?? '', takeover, 60_000)).toBeUndefined();
  });

  it('opens one cycle per (plan, due time) and logs its steps', async () => {
    const p = await plan();
    const dueAt = '2026-09-28T13:32:00.000Z';
    const first = await openCycle(db, { planId: p.id, dueAt, executionMode: 'simulate' });
    const again = await openCycle(db, { planId: p.id, dueAt, executionMode: 'simulate' });
    expect(first.created).toBe(true);
    expect(again).toEqual({ cycle: first.cycle, created: false });

    await appendCycleStep(db, first.cycle.id, { step: 'WINDOW', ok: true });
    await appendCycleStep(db, first.cycle.id, { step: 'QUOTE', spendUsd: '5' });
    await updateCycle(db, first.cycle.id, {
      state: 'done',
      outcomeKind: 'DEFERRED',
      outcome: { kind: 'DEFERRED', reason: 'market_closed', retryAt: '2026-09-28T13:32:00.000Z' },
      whyKey: 'why.deferred.market_closed',
      whyParams: { time: '22:32' },
    });
    const stored = await getCycle(db, first.cycle.id);
    expect(stored?.steps).toEqual([
      { step: 'WINDOW', ok: true },
      { step: 'QUOTE', spendUsd: '5' },
    ]);
    expect(stored).toMatchObject({
      state: 'done',
      outcomeKind: 'DEFERRED',
      executionMode: 'simulate',
    });
    expect((await listCycles(db, { planIds: [p.id] })).map((c) => c.id)).toEqual([first.cycle.id]);

    expect(
      await violatedConstraint(updateCycle(db, first.cycle.id, { outcomeKind: 'MAYBE' })),
    ).toBe('cycles_outcome_kind_ck');
    expect(
      await violatedConstraint(
        openCycle(db, { planId: 'no-such-plan', dueAt, executionMode: 'simulate' }),
      ),
    ).toBe('cycles_plan_id_plans_id_fk');
  });

  it('finds cycles left awaiting a transaction', async () => {
    const p = await plan();
    const cycleId = await newCycle(db, p.id);
    await updateCycle(db, cycleId, { state: 'awaiting_tx' });
    expect((await cyclesAwaitingTx(db)).map((c) => c.id)).toContain(cycleId);
  });

  it('stores a receipt once per transaction hash', async () => {
    const p = await plan();
    const cycleId = await newCycle(db, p.id);
    const receipt = {
      cycleId,
      planId: p.id,
      kind: 'swap',
      txHash: txHash(),
      explorerUrl: 'https://bscscan.com/tx/0x',
      chainId: 56,
      amounts: { spendUsd: '5', tokens: '28000000000000000' },
      broadcastVia: 'transaction_api',
      status: 'success',
    };
    expect(await insertReceipt(db, receipt)).toBe(true);
    expect(await insertReceipt(db, receipt)).toBe(false);
    expect((await listReceipts(db, { planIds: [p.id] })).map((r) => r.txHash)).toEqual([
      receipt.txHash,
    ]);
    expect(
      await violatedConstraint(insertReceipt(db, { ...receipt, txHash: txHash(), kind: 'gift' })),
    ).toBe('receipts_kind_ck');
  });

  it('upserts holdings with the multiplier snapshot', async () => {
    const p = await plan();
    const base = {
      planId: p.id,
      instrumentId: 'NVDA:bstocks',
      tokens: '28000000000000000',
      decimals: 18,
      multiplierAtLastUpdate: '1',
      shares: '0.028',
      costUsd: '5',
    };
    await upsertHolding(db, base);
    await upsertHolding(db, {
      ...base,
      tokens: '56000000000000000',
      shares: '0.056',
      costUsd: '10',
    });
    const row = await getHolding(db, p.id, 'NVDA:bstocks');
    if (!row) throw new Error('holding missing');
    expect(holdingFromRow(row)).toMatchObject({
      tokens: '56000000000000000',
      shares: '0.056',
      costUsd: '10',
    });
    expect(await listHoldings(db, p.id)).toHaveLength(1);
  });

  it('records guardian events and resolves them by rule', async () => {
    const p = await plan();
    const rule = `test-rule-${randomBytes(4).toString('hex')}`;
    await insertGuardianEvent(db, {
      rule,
      action: 'pause_buys',
      detail: { tvlChange24hPct: -31 },
      planId: p.id,
    });
    expect(await listGuardianEvents(db, { planId: p.id, openOnly: true })).toHaveLength(1);
    await resolveGuardianEvents(db, rule, new Date('2026-09-28T15:00:00.000Z'));
    expect(await listGuardianEvents(db, { planId: p.id, openOnly: true })).toHaveLength(0);
    expect(await listGuardianEvents(db, { planId: p.id })).toHaveLength(1);
  });

  it('lists with a plan the global holds in force at any time since it was created', async () => {
    const p = await plan();
    const tag = randomBytes(4).toString('hex');
    const hold = (name: string, ts: string, resolvedAt: string) =>
      insertGuardianEvent(db, {
        rule: `test-global-${name}-${tag}`,
        action: 'pause_buys',
        detail: {},
        planId: null,
        ts,
        resolvedAt,
      });
    // Far in the past, resolved: no other test's plan (created now) ever lists them.
    await hold('before', '2019-12-01T00:00:00.000Z', '2019-12-15T00:00:00.000Z');
    await hold('across', '2019-12-20T00:00:00.000Z', '2020-01-05T00:00:00.000Z');
    await hold('after', '2020-01-10T00:00:00.000Z', '2020-01-11T00:00:00.000Z');
    try {
      const listed = await listGuardianEvents(db, {
        planId: p.id,
        globalSince: '2020-01-01T00:00:00.000Z',
        limit: 1000,
      });
      // A hold raised before the plan and lifted after it skipped the plan's cycles too.
      expect(listed.filter((e) => e.rule.endsWith(tag)).map((e) => e.rule.split('-')[2])).toEqual([
        'after',
        'across',
      ]);
    } finally {
      await db.delete(guardianEvents).where(like(guardianEvents.rule, `test-global-%-${tag}`));
    }
  });

  it('filters plans by owner', async () => {
    const ref = `judge-${randomBytes(4).toString('hex')}`;
    const mine = await plan({ ownerKind: 'judge', ownerRef: ref });
    await plan({ ownerKind: 'judge', ownerRef: `${ref}-other` });
    expect((await listPlans(db, { ownerKind: 'judge', ownerRef: ref })).map((p) => p.id)).toEqual([
      mine.id,
    ]);
    const judge = planFromRow(mine);
    expect(judge.owner).toEqual({ kind: 'judge', code: ref });
    const rows = await db
      .select()
      .from(plans)
      .where(inArray(plans.id, [mine.id]));
    expect(rows).toHaveLength(1);
  });
});
