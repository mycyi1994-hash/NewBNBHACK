/**
 * Plans, cycles, holdings, receipts and guardian events (SPEC §4–§6). The scheduler's lock is a
 * conditional UPDATE on `lock_until`, so two workers can never run the same plan at once.
 */
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import { cycles, guardianEvents, holdings, plans, receipts } from './schema.js';

export type PlanRow = typeof plans.$inferSelect;
export type PlanInsert = typeof plans.$inferInsert;
export type CycleRow = typeof cycles.$inferSelect;
export type HoldingRow = typeof holdings.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;
export type ReceiptInsert = typeof receipts.$inferInsert;
export type GuardianEventRow = typeof guardianEvents.$inferSelect;

export async function insertPlan(db: Db, row: PlanInsert): Promise<PlanRow> {
  const [created] = await db.insert(plans).values(row).returning();
  if (!created) throw new Error(`plan ${row.id} was not inserted`);
  return created;
}

/** Inserts the plan unless one with the same id exists (seeds never overwrite live state). */
export async function insertPlanIfMissing(db: Db, row: PlanInsert): Promise<boolean> {
  const created = await db
    .insert(plans)
    .values(row)
    .onConflictDoNothing({ target: plans.id })
    .returning({ id: plans.id });
  return created.length > 0;
}

export async function getPlan(db: Db, id: string): Promise<PlanRow | undefined> {
  const [row] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  return row;
}

export async function listPlans(
  db: Db,
  filter: { ownerKind?: string; ownerRef?: string } = {},
): Promise<PlanRow[]> {
  return db
    .select()
    .from(plans)
    .where(
      and(
        filter.ownerKind === undefined ? undefined : eq(plans.ownerKind, filter.ownerKind),
        filter.ownerRef === undefined ? undefined : eq(plans.ownerRef, filter.ownerRef),
      ),
    )
    .orderBy(asc(plans.createdAt), asc(plans.id));
}

/** Active plans whose cycle is due and that nobody holds. */
export async function duePlans(db: Db, now: Date): Promise<PlanRow[]> {
  const nowIso = now.toISOString();
  return db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.status, 'active'),
        lte(plans.nextDueAt, nowIso),
        or(isNull(plans.lockUntil), lt(plans.lockUntil, nowIso)),
      ),
    )
    .orderBy(asc(plans.nextDueAt));
}

/** Takes the plan's lock for `ttlMs`; undefined when another holder has it. */
export async function acquirePlanLock(
  db: Db,
  id: string,
  now: Date,
  ttlMs: number,
): Promise<PlanRow | undefined> {
  const nowIso = now.toISOString();
  const [row] = await db
    .update(plans)
    .set({ lockUntil: new Date(now.getTime() + ttlMs).toISOString() })
    .where(and(eq(plans.id, id), or(isNull(plans.lockUntil), lt(plans.lockUntil, nowIso))))
    .returning();
  return row;
}

export type PlanPatch = Partial<
  Pick<
    PlanInsert,
    | 'status'
    | 'pausedReason'
    | 'nextDueAt'
    | 'harvestedUnspentUsd'
    | 'principalUsd'
    | 'vtokenUnits'
    | 'expiresAt'
  >
>;

/** Applies `patch` and releases the lock. */
export async function releasePlanLock(db: Db, id: string, patch: PlanPatch = {}): Promise<void> {
  await db
    .update(plans)
    .set({ ...patch, lockUntil: null })
    .where(eq(plans.id, id));
}

export async function updatePlan(
  db: Db,
  id: string,
  patch: PlanPatch,
): Promise<PlanRow | undefined> {
  const [row] = await db.update(plans).set(patch).where(eq(plans.id, id)).returning();
  return row;
}

/** Opens the cycle for (plan, dueAt), or returns the one already opened for it. */
export async function openCycle(
  db: Db,
  args: { planId: string; dueAt: string; executionMode: 'simulate' | 'live' },
): Promise<{ cycle: CycleRow; created: boolean }> {
  const [created] = await db
    .insert(cycles)
    .values(args)
    .onConflictDoNothing({ target: [cycles.planId, cycles.dueAt] })
    .returning();
  if (created) return { cycle: created, created: true };
  const [existing] = await db
    .select()
    .from(cycles)
    .where(and(eq(cycles.planId, args.planId), eq(cycles.dueAt, args.dueAt)))
    .limit(1);
  if (!existing) throw new Error(`cycle ${args.planId}@${args.dueAt} vanished`);
  return { cycle: existing, created: false };
}

/** Appends one entry to the cycle's step log. */
export async function appendCycleStep(
  db: Db,
  id: number,
  step: Record<string, unknown>,
): Promise<void> {
  await db
    .update(cycles)
    .set({ steps: sql`${cycles.steps} || ${JSON.stringify([step])}::jsonb` })
    .where(eq(cycles.id, id));
}

export type CyclePatch = Partial<
  Pick<
    typeof cycles.$inferInsert,
    | 'state'
    | 'outcomeKind'
    | 'outcome'
    | 'whyKey'
    | 'whyParams'
    | 'instrumentId'
    | 'spendUsd'
    | 'interestUsd'
    | 'retryAt'
    | 'finishedAt'
  >
>;

export async function updateCycle(db: Db, id: number, patch: CyclePatch): Promise<void> {
  await db.update(cycles).set(patch).where(eq(cycles.id, id));
}

export async function getCycle(db: Db, id: number): Promise<CycleRow | undefined> {
  const [row] = await db.select().from(cycles).where(eq(cycles.id, id)).limit(1);
  return row;
}

export async function listCycles(
  db: Db,
  filter: { planIds?: readonly string[]; limit?: number } = {},
): Promise<CycleRow[]> {
  return db
    .select()
    .from(cycles)
    .where(filter.planIds ? inArray(cycles.planId, [...filter.planIds]) : undefined)
    .orderBy(desc(cycles.startedAt), desc(cycles.id))
    .limit(filter.limit ?? 50);
}

/** Cycles left 'awaiting_tx' by a broadcast whose receipt has not been reconciled yet. */
export async function cyclesAwaitingTx(db: Db): Promise<CycleRow[]> {
  return db.select().from(cycles).where(eq(cycles.state, 'awaiting_tx')).orderBy(asc(cycles.id));
}

export async function getHolding(
  db: Db,
  planId: string,
  instrumentId: string,
): Promise<HoldingRow | undefined> {
  const [row] = await db
    .select()
    .from(holdings)
    .where(and(eq(holdings.planId, planId), eq(holdings.instrumentId, instrumentId)))
    .limit(1);
  return row;
}

export async function upsertHolding(db: Db, row: typeof holdings.$inferInsert): Promise<void> {
  await db
    .insert(holdings)
    .values(row)
    .onConflictDoUpdate({
      target: [holdings.planId, holdings.instrumentId],
      set: {
        tokens: row.tokens,
        decimals: row.decimals,
        multiplierAtLastUpdate: row.multiplierAtLastUpdate,
        shares: row.shares,
        costUsd: row.costUsd,
        updatedAt: sql`now()`,
      },
    });
}

export async function listHoldings(db: Db, planId?: string): Promise<HoldingRow[]> {
  return db
    .select()
    .from(holdings)
    .where(planId === undefined ? undefined : eq(holdings.planId, planId))
    .orderBy(asc(holdings.planId), asc(holdings.instrumentId));
}

/** Records a receipt once; a repeated tx hash (reconciliation after a restart) is a no-op. */
export async function insertReceipt(db: Db, row: ReceiptInsert): Promise<boolean> {
  const created = await db
    .insert(receipts)
    .values(row)
    .onConflictDoNothing({ target: receipts.txHash })
    .returning({ id: receipts.id });
  return created.length > 0;
}

export async function listReceipts(
  db: Db,
  filter: { planIds?: readonly string[]; limit?: number } = {},
): Promise<ReceiptRow[]> {
  return db
    .select()
    .from(receipts)
    .where(filter.planIds ? inArray(receipts.planId, [...filter.planIds]) : undefined)
    .orderBy(desc(receipts.createdAt), desc(receipts.id))
    .limit(filter.limit ?? 50);
}

export async function insertGuardianEvent(
  db: Db,
  row: typeof guardianEvents.$inferInsert,
): Promise<GuardianEventRow> {
  const [created] = await db.insert(guardianEvents).values(row).returning();
  if (!created) throw new Error('guardian event was not inserted');
  return created;
}

export async function listGuardianEvents(
  db: Db,
  filter: { planId?: string; openOnly?: boolean; limit?: number } = {},
): Promise<GuardianEventRow[]> {
  return db
    .select()
    .from(guardianEvents)
    .where(
      and(
        filter.planId === undefined ? undefined : eq(guardianEvents.planId, filter.planId),
        filter.openOnly ? isNull(guardianEvents.resolvedAt) : undefined,
      ),
    )
    .orderBy(desc(guardianEvents.ts), desc(guardianEvents.id))
    .limit(filter.limit ?? 50);
}

export async function resolveGuardianEvents(db: Db, rule: string, at: Date): Promise<void> {
  await db
    .update(guardianEvents)
    .set({ resolvedAt: at.toISOString() })
    .where(and(eq(guardianEvents.rule, rule), isNull(guardianEvents.resolvedAt)));
}
