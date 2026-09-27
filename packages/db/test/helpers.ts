/** Shared helpers for the @yieldvest/db integration tests (disposable database only). */
import { randomInt, randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import {
  cycles,
  guardianEvents,
  holdings,
  jobs,
  openCycle,
  plans,
  receipts,
  spendLedger,
  txOutbox,
  type Db,
  type PlanInsert,
} from '../src/index.js';

export const testDatabaseUrl = process.env.YIELDVEST_TEST_DATABASE_URL;

/** A valid plan row with a unique id; override what the test is about. */
export function testPlan(overrides: Partial<PlanInsert> = {}): PlanInsert {
  return {
    id: `T-${randomUUID()}`,
    ownerKind: 'house',
    mode: 'safe',
    ticker: 'NVDA',
    issuerPreference: ['bstocks', 'ondo'],
    contributionUsd: '5',
    cadence: 'daily',
    window: 'regular_session',
    maxPerBuyUsd: '5',
    maxDailyUsd: '5',
    nextDueAt: '2026-09-28T13:32:00.000Z',
    ...overrides,
  };
}

/** A UTC day nobody else uses: the global cap sums every plan's rows for the day. */
export function isolatedDay(): string {
  const day = new Date(Date.UTC(2100 + randomInt(0, 800), randomInt(0, 12), randomInt(1, 29)));
  return day.toISOString().slice(0, 10);
}

/** Opens cycle number `n` of the plan (a distinct due time per n). */
export async function newCycle(db: Db, planId: string, n = 0): Promise<number> {
  const dueAt = new Date(Date.UTC(2026, 8, 28, 13, 32) + n * 60_000).toISOString();
  const { cycle } = await openCycle(db, { planId, dueAt, executionMode: 'simulate' });
  return cycle.id;
}

/** Deletes test plans and everything that references them (foreign keys never cascade). */
export async function deletePlans(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const list = [...ids];
  await db.delete(jobs).where(inArray(jobs.planId, list));
  await db.delete(txOutbox).where(inArray(txOutbox.planId, list));
  await db.delete(spendLedger).where(inArray(spendLedger.planId, list));
  await db.delete(receipts).where(inArray(receipts.planId, list));
  await db.delete(holdings).where(inArray(holdings.planId, list));
  await db.delete(guardianEvents).where(inArray(guardianEvents.planId, list));
  await db.delete(cycles).where(inArray(cycles.planId, list));
  await db.delete(plans).where(inArray(plans.id, list));
}

/** The Postgres error behind a failed query (drizzle wraps it in DrizzleQueryError.cause). */
export function pgError(error: unknown): { code?: string; constraint_name?: string } {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(current.code)
    ) {
      return current as { code?: string; constraint_name?: string };
    }
    current = current.cause;
  }
  return {};
}

/** Resolves to the constraint a rejected query violated. */
export async function violatedConstraint(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    return pgError(error).constraint_name;
  }
  throw new Error('query succeeded; a constraint violation was expected');
}
