/**
 * Spend ledger on Postgres (SPEC §4 v2, CLAUDE.md rule 5): every cap is checked and reserved in
 * one transaction, so concurrent cycles can never squeeze past a cap together.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deletePlans,
  isolatedDay,
  newCycle,
  testPlan,
  testDatabaseUrl as url,
  violatedConstraint,
} from '../test/helpers.js';
import {
  createDb,
  insertPlan,
  planSpendOnDay,
  remainingSpend,
  reserveSpend,
  settleSpend,
  usdText,
  utcDay,
  type SpendCaps,
  type SpendScope,
} from './index.js';

describe('utcDay', () => {
  it('is the UTC calendar day, not New York or Seoul', () => {
    expect(utcDay(new Date('2026-09-28T23:59:59.999Z'))).toBe('2026-09-28');
    expect(utcDay(new Date('2026-09-29T00:00:00.000Z'))).toBe('2026-09-29');
  });
});

describe.skipIf(!url)('spend ledger on Postgres', () => {
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

  function scope(
    planRow: { id: string; ownerKind: string; ownerRef: string | null },
    day: string,
    caps: SpendCaps,
  ): SpendScope {
    return {
      planId: planRow.id,
      ownerKind: planRow.ownerKind,
      ownerRef: planRow.ownerRef,
      day,
      caps,
    };
  }

  it('refuses a reservation past the plan cap and reports what is left', async () => {
    const p = await plan();
    const s = scope(p, isolatedDay(), { globalDailyUsd: '50', planDailyUsd: '5' });
    expect(
      await reserveSpend(db, { ...s, cycleId: await newCycle(db, p.id, 0), amountUsd: '3' }),
    ).toMatchObject({ ok: true });
    expect(
      await reserveSpend(db, { ...s, cycleId: await newCycle(db, p.id, 1), amountUsd: '3' }),
    ).toEqual({ ok: false, reason: 'plan_daily' });
    expect(usdText(await remainingSpend(db, s))).toBe('2');
    // Exactly up to the cap is allowed.
    expect(
      await reserveSpend(db, { ...s, cycleId: await newCycle(db, p.id, 2), amountUsd: '2' }),
    ).toMatchObject({ ok: true });
    expect(usdText(await remainingSpend(db, s))).toBe('0');
  });

  it('counts every house-wallet plan against the global daily cap', async () => {
    const day = isolatedDay();
    const caps = { globalDailyUsd: '8', planDailyUsd: '5' };
    const a = await plan();
    const b = await plan();
    expect(
      await reserveSpend(db, {
        ...scope(a, day, caps),
        cycleId: await newCycle(db, a.id),
        amountUsd: '5',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await reserveSpend(db, {
        ...scope(b, day, caps),
        cycleId: await newCycle(db, b.id),
        amountUsd: '5',
      }),
    ).toEqual({ ok: false, reason: 'global_daily' });
    expect(usdText(await remainingSpend(db, scope(b, day, caps)))).toBe('3');
    // Another day starts from zero.
    expect(usdText(await remainingSpend(db, scope(b, isolatedDay(), caps)))).toBe('5');
  });

  it("keeps skill plans (the user's own wallet) out of the house wallet's daily cap", async () => {
    const day = isolatedDay();
    const house = await plan();
    const skill = await plan({ ownerKind: 'skill', ownerRef: `sk_${randomUUID()}` });
    const houseCaps = { globalDailyUsd: '8', planDailyUsd: '5' };
    const skillCaps = { globalDailyUsd: '5', planDailyUsd: '5' };
    expect(
      await reserveSpend(db, {
        ...scope(skill, day, skillCaps),
        cycleId: await newCycle(db, skill.id),
        amountUsd: '5',
      }),
    ).toMatchObject({ ok: true });
    // The skill wallet's $5 leaves the house's $8 untouched…
    expect(usdText(await remainingSpend(db, scope(house, day, houseCaps)))).toBe('5');
    expect(
      await reserveSpend(db, {
        ...scope(house, day, houseCaps),
        cycleId: await newCycle(db, house.id),
        amountUsd: '5',
      }),
    ).toMatchObject({ ok: true });
    // …and the house's spending does not count against the skill plan's own day.
    const second = await plan({ ownerKind: 'skill', ownerRef: `sk_${randomUUID()}` });
    expect(usdText(await remainingSpend(db, scope(second, day, skillCaps)))).toBe('5');
    expect(usdText(await remainingSpend(db, scope(skill, day, skillCaps)))).toBe('0');
  });

  it('frees a released reservation and keeps the actual amount of a spent one', async () => {
    const p = await plan();
    const s = scope(p, isolatedDay(), { globalDailyUsd: '50', planDailyUsd: '5' });
    const first = await newCycle(db, p.id, 0);
    expect(await reserveSpend(db, { ...s, cycleId: first, amountUsd: '5' })).toMatchObject({
      ok: true,
    });
    await settleSpend(db, first, 'released');
    expect(usdText(await remainingSpend(db, s))).toBe('5');

    const second = await newCycle(db, p.id, 1);
    expect(await reserveSpend(db, { ...s, cycleId: second, amountUsd: '5' })).toMatchObject({
      ok: true,
    });
    await settleSpend(db, second, 'spent', '4.2');
    expect(usdText(await remainingSpend(db, s))).toBe('0.8');
  });

  it("caps a judge code's total across its plans and days, and only that code", async () => {
    const caps = { globalDailyUsd: '50', planDailyUsd: '5', judgeTotalUsd: '5' };
    const ref = `judge-${randomUUID()}`;
    const first = await plan({ ownerKind: 'judge', ownerRef: ref });
    const second = await plan({ ownerKind: 'judge', ownerRef: ref });
    const other = await plan({ ownerKind: 'judge', ownerRef: `judge-${randomUUID()}` });
    expect(
      await reserveSpend(db, {
        ...scope(first, isolatedDay(), caps),
        cycleId: await newCycle(db, first.id),
        amountUsd: '3',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await reserveSpend(db, {
        ...scope(second, isolatedDay(), caps),
        cycleId: await newCycle(db, second.id),
        amountUsd: '3',
      }),
    ).toEqual({ ok: false, reason: 'judge_total' });
    expect(usdText(await remainingSpend(db, scope(second, isolatedDay(), caps)))).toBe('2');
    expect(
      await reserveSpend(db, {
        ...scope(other, isolatedDay(), caps),
        cycleId: await newCycle(db, other.id),
        amountUsd: '3',
      }),
    ).toMatchObject({ ok: true });
  });

  it('never lets concurrent cycles squeeze past the cap together', async () => {
    // $2 against $5: exactly two fit. Without the lock, transactions that start together all see
    // an empty ledger and all insert (checked by removing the lock: the test then fails).
    const p = await plan();
    const s = scope(p, isolatedDay(), { globalDailyUsd: '50', planDailyUsd: '5' });
    const cycleIds = await Promise.all(Array.from({ length: 10 }, (_, i) => newCycle(db, p.id, i)));
    const results = await Promise.all(
      cycleIds.map((cycleId) => reserveSpend(db, { ...s, cycleId, amountUsd: '2' })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toEqual(
      Array.from({ length: 8 }, () => ({ ok: false, reason: 'plan_daily' })),
    );
    expect(usdText(await remainingSpend(db, s))).toBe('1');
  });

  it("sums a plan's reserved and spent amounts for one day, not released ones", async () => {
    const p = await plan();
    const day = isolatedDay();
    const s = scope(p, day, { globalDailyUsd: '50', planDailyUsd: '10' });
    const first = await newCycle(db, p.id, 0);
    const second = await newCycle(db, p.id, 1);
    const third = await newCycle(db, p.id, 2);
    await reserveSpend(db, { ...s, cycleId: first, amountUsd: '2' });
    await reserveSpend(db, { ...s, cycleId: second, amountUsd: '3' });
    await reserveSpend(db, { ...s, cycleId: third, amountUsd: '4' });
    await settleSpend(db, second, 'spent', '2.5');
    await settleSpend(db, third, 'released');
    expect(usdText(await planSpendOnDay(db, p.id, day))).toBe('4.5');
    expect(usdText(await planSpendOnDay(db, p.id, isolatedDay()))).toBe('0');
  });

  it('reserves once per cycle', async () => {
    const p = await plan();
    const s = scope(p, isolatedDay(), { globalDailyUsd: '50', planDailyUsd: '5' });
    const cycleId = await newCycle(db, p.id);
    expect(await reserveSpend(db, { ...s, cycleId, amountUsd: '1' })).toMatchObject({ ok: true });
    expect(await violatedConstraint(reserveSpend(db, { ...s, cycleId, amountUsd: '1' }))).toBe(
      'spend_ledger_cycle_uq',
    );
  });
});
