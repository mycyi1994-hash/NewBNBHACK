/**
 * Plans, cycles, holdings, receipts and guardian events (SPEC §4–§6). The scheduler's lock is a
 * conditional UPDATE on `lock_until`, so two workers can never run the same plan at once.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { newSkillToken } from './auth.js';
import type { Db } from './index.js';
import { cycles, guardianEvents, holdings, plans, receipts, skillTokens } from './schema.js';

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

/**
 * A judge plan, unless the code already made `maxPerHour` in the last hour. The count and the
 * insert run under one lock per code, so concurrent requests never pass the limit together.
 */
export async function insertJudgePlan(
  db: Db,
  row: PlanInsert & { ownerRef: string },
  maxPerHour: number,
): Promise<PlanRow | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`judge-plans:${row.ownerRef}`}))`);
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(plans)
      .where(
        and(
          eq(plans.ownerKind, 'judge'),
          eq(plans.ownerRef, row.ownerRef),
          sql`${plans.createdAt} > now() - interval '1 hour'`,
        ),
      );
    if ((recent?.n ?? 0) >= maxPerHour) return undefined;
    const [created] = await tx.insert(plans).values(row).returning();
    return created;
  });
}

/**
 * A skill plan and its bearer token (shown once, only its hash stored), unless the wallet already
 * has `maxOpen` plans that are not stopped — counted and written under one lock per wallet.
 */
export async function insertSkillPlan(
  db: Db,
  row: Omit<PlanInsert, 'ownerKind' | 'ownerRef'> & { walletAddress: string },
  maxOpen: number,
): Promise<{ plan: PlanRow; tokenId: string; token: string } | undefined> {
  const wallet = row.walletAddress;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`skill-plans:${wallet.toLowerCase()}`}))`,
    );
    const [open] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(plans)
      .where(
        and(
          eq(plans.ownerKind, 'skill'),
          sql`lower(${plans.walletAddress}) = lower(${wallet})`,
          sql`${plans.status} <> 'stopped'`,
        ),
      );
    if ((open?.n ?? 0) >= maxOpen) return undefined;
    const { id: tokenId, token, tokenHash } = newSkillToken();
    await tx.insert(skillTokens).values({ id: tokenId, tokenHash, walletAddress: wallet });
    const [plan] = await tx
      .insert(plans)
      .values({ ...row, ownerKind: 'skill', ownerRef: tokenId })
      .returning();
    if (!plan) throw new Error(`plan ${row.id} was not inserted`);
    return { plan, tokenId, token };
  });
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
  /** `walletAddress` matches whatever case the address was stored in. */
  filter: { ownerKind?: string; ownerRef?: string; walletAddress?: string } = {},
): Promise<PlanRow[]> {
  return db
    .select()
    .from(plans)
    .where(
      and(
        filter.ownerKind === undefined ? undefined : eq(plans.ownerKind, filter.ownerKind),
        filter.ownerRef === undefined ? undefined : eq(plans.ownerRef, filter.ownerRef),
        filter.walletAddress === undefined
          ? undefined
          : sql`lower(${plans.walletAddress}) = ${filter.walletAddress.toLowerCase()}`,
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

/**
 * Extends the lock to `now + ttlMs` — only while this holder still has it: `lockUntil` is the value
 * it holds (from acquirePlanLock or the last renewal). Every other holder changes the value, so a
 * lock that lapsed is still renewed when nobody took it over. Returns the new value, or undefined
 * when the lock was taken over or released (the new holder decides from then on).
 */
export async function renewPlanLock(
  db: Db,
  id: string,
  lockUntil: string,
  now: Date,
  ttlMs: number,
): Promise<string | undefined> {
  const [row] = await db
    .update(plans)
    .set({ lockUntil: new Date(now.getTime() + ttlMs).toISOString() })
    .where(and(eq(plans.id, id), eq(plans.lockUntil, lockUntil)))
    .returning({ lockUntil: plans.lockUntil });
  return row?.lockUntil ?? undefined;
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
    // Operator settings (pnpm plan:set), checked against the caps before they are written.
    | 'contributionUsd'
    | 'maxPerBuyUsd'
    | 'maxDailyUsd'
    | 'cadence'
    | 'window'
  >
>;

/**
 * Applies `patch` and releases the lock — only when this holder still has it: `lockUntil` is the
 * value acquirePlanLock set. A holder whose lock expired and was taken over releases nothing and
 * writes nothing (the new holder decides). Returns whether it did.
 */
export async function releasePlanLock(
  db: Db,
  id: string,
  lockUntil: string | null,
  patch: PlanPatch = {},
): Promise<boolean> {
  if (lockUntil === null) return false;
  const rows = await db
    .update(plans)
    .set({ ...patch, lockUntil: null })
    .where(and(eq(plans.id, id), eq(plans.lockUntil, lockUntil)))
    .returning({ id: plans.id });
  return rows.length > 0;
}

export async function updatePlan(
  db: Db,
  id: string,
  patch: PlanPatch,
): Promise<PlanRow | undefined> {
  const [row] = await db.update(plans).set(patch).where(eq(plans.id, id)).returning();
  return row;
}

/**
 * Applies `patch` only while the plan's status and paused reason are still the ones the caller
 * read: a stop, a guardian pause or a review hold written in between is never overwritten.
 * Returns whether it did.
 */
export async function updatePlanIf(
  db: Db,
  id: string,
  expected: { status: PlanRow['status']; pausedReason: string | null },
  patch: PlanPatch,
): Promise<boolean> {
  const rows = await db
    .update(plans)
    .set(patch)
    .where(
      and(
        eq(plans.id, id),
        eq(plans.status, expected.status),
        expected.pausedReason === null
          ? isNull(plans.pausedReason)
          : eq(plans.pausedReason, expected.pausedReason),
      ),
    )
    .returning({ id: plans.id });
  return rows.length > 0;
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
/** A plan's cycles in any of `states` (e.g. 'running', 'awaiting_tx'), oldest first. */
export async function cyclesOfPlan(
  db: Db,
  planId: string,
  states: readonly string[],
): Promise<CycleRow[]> {
  return db
    .select()
    .from(cycles)
    .where(and(eq(cycles.planId, planId), inArray(cycles.state, [...states])))
    .orderBy(asc(cycles.id));
}

export async function cyclesAwaitingTx(db: Db): Promise<CycleRow[]> {
  return db.select().from(cycles).where(eq(cycles.state, 'awaiting_tx')).orderBy(asc(cycles.id));
}

/** Every plan's cycles still marked 'running' (a live one holds its plan's lock; a dead one does not). */
export async function cyclesRunning(db: Db): Promise<CycleRow[]> {
  return db.select().from(cycles).where(eq(cycles.state, 'running')).orderBy(asc(cycles.id));
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
    .values({ ...row, txHash: row.txHash.toLowerCase() })
    .onConflictDoNothing({ target: receipts.txHash })
    .returning({ id: receipts.id });
  return created.length > 0;
}

export async function receiptByHash(db: Db, txHash: string): Promise<ReceiptRow | undefined> {
  const [row] = await db
    .select()
    .from(receipts)
    .where(eq(receipts.txHash, txHash.toLowerCase()))
    .limit(1);
  return row;
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

/** The Wallet API's view of a receipt's transaction (DECISIONS D-34); the BSC receipt stays the record. */
export type ReceiptIndex =
  | {
      state: 'indexed';
      txStatus: 'success' | 'fail' | 'pending';
      /** Fee in BNB, as the Wallet API wrote it. */
      txFee: string | null;
      height: string | null;
      /** Whether its final status matches the BSC receipt's; null while it says pending. */
      agrees: boolean | null;
      checkedAt: string;
    }
  | { state: 'not_indexed'; tries: number; checkedAt: string };

/**
 * Receipts the Wallet API has not reported final yet — never checked, not indexed yet, or pending —
 * created since `since`, newest first: what the worker asks about on its next tick.
 */
export async function receiptsToIndex(db: Db, since: Date, limit = 5): Promise<ReceiptRow[]> {
  return db
    .select()
    .from(receipts)
    .where(
      and(
        gte(receipts.createdAt, since.toISOString()),
        sql`(${receipts.indexed} is null or ${receipts.indexed}->>'state' = 'not_indexed' or ${receipts.indexed}->>'txStatus' = 'pending')`,
      ),
    )
    .orderBy(desc(receipts.createdAt), desc(receipts.id))
    .limit(limit);
}

export async function recordReceiptIndex(
  db: Db,
  txHash: string,
  index: ReceiptIndex,
): Promise<void> {
  await db
    .update(receipts)
    .set({ indexed: index })
    .where(eq(receipts.txHash, txHash.toLowerCase()));
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
  filter: {
    planId?: string;
    /**
     * With planId: also the global events in force at any time since this time (ISO) — still
     * open, or resolved after it (raised before or after).
     */
    globalSince?: string;
    openOnly?: boolean;
    limit?: number;
  } = {},
): Promise<GuardianEventRow[]> {
  return db
    .select()
    .from(guardianEvents)
    .where(
      and(
        filter.planId === undefined
          ? undefined
          : filter.globalSince === undefined
            ? eq(guardianEvents.planId, filter.planId)
            : or(
                eq(guardianEvents.planId, filter.planId),
                and(
                  isNull(guardianEvents.planId),
                  or(
                    isNull(guardianEvents.resolvedAt),
                    gte(guardianEvents.resolvedAt, filter.globalSince),
                  ),
                ),
              ),
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
