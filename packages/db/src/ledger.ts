/**
 * Spend ledger (SPEC §4 v2): the single source for daily caps. A reservation checks every cap and
 * inserts its row inside one transaction under an advisory lock, so two cycles can never both
 * squeeze under the same cap (no check-then-act race). Amounts are compared as Postgres numeric.
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import { spendLedger } from './schema.js';

/** pg_advisory_xact_lock key for every ledger reservation. */
const SPEND_LOCK = 471_203_001;

export interface SpendCaps {
  /**
   * Everything the house wallet may spend in one UTC day: house and judge plans together. A skill
   * plan spends from the user's own wallet, so for it this is its own plan's day.
   */
  globalDailyUsd: string;
  /** This plan's own daily limit. */
  planDailyUsd: string;
  /** Judge plans: what one judge code may spend in total, across all its plans and days. */
  judgeTotalUsd?: string;
}

export interface SpendScope {
  planId: string;
  /** 'house' | 'judge' | 'skill'. */
  ownerKind: string;
  /** Judge code hash for judge plans. */
  ownerRef: string | null;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  caps: SpendCaps;
}

export type ReserveResult =
  | { ok: true; ledgerId: number }
  | { ok: false; reason: 'global_daily' | 'plan_daily' | 'judge_total' };

/** UTC calendar day of `at`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function usageQuery(scope: SpendScope) {
  const judge = scope.ownerKind === 'judge' && scope.ownerRef !== null;
  // The house wallet pays for house and judge plans; a skill plan's wallet is the user's own, so
  // neither side's spending may use up the other's room.
  const houseWallet = scope.ownerKind === 'house' || scope.ownerKind === 'judge';
  return sql`
    select
      ${
        houseWallet
          ? sql`coalesce(sum(amount_usd) filter (where day = ${scope.day} and plan_id in (select id from plans where owner_kind in ('house', 'judge'))), 0)::numeric`
          : sql`coalesce(sum(amount_usd) filter (where day = ${scope.day} and plan_id = ${scope.planId}), 0)::numeric`
      } as global_day,
      coalesce(sum(amount_usd) filter (where day = ${scope.day} and plan_id = ${scope.planId}), 0)::numeric as plan_day,
      ${
        judge
          ? sql`coalesce(sum(amount_usd) filter (where plan_id in (select id from plans where owner_kind = 'judge' and owner_ref = ${scope.ownerRef})), 0)::numeric`
          : sql`0::numeric`
      } as judge_total
    from spend_ledger
    where status in ('reserved', 'spent')`;
}

/** What the plan may still spend today: the tightest remaining cap, never below zero. */
export async function remainingSpend(db: Db, scope: SpendScope): Promise<string> {
  const judgeCap = scope.ownerKind === 'judge' ? scope.caps.judgeTotalUsd : undefined;
  const rows = await db.execute<{ remaining: string }>(sql`
    with usage as (${usageQuery(scope)})
    select greatest(least(
      ${scope.caps.globalDailyUsd}::numeric - global_day,
      ${scope.caps.planDailyUsd}::numeric - plan_day,
      ${judgeCap === undefined ? sql`'Infinity'::numeric` : sql`${judgeCap}::numeric - judge_total`}
    ), 0)::text as remaining
    from usage`);
  const remaining = rows[0]?.remaining;
  if (remaining === undefined) throw new Error('spend usage query returned no row');
  return remaining;
}

/** Reserves `amountUsd` for `cycleId` if every cap still allows it. */
export async function reserveSpend(
  db: Db,
  scope: SpendScope & { cycleId: number; amountUsd: string },
): Promise<ReserveResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SPEND_LOCK})`);
    const judgeCap = scope.ownerKind === 'judge' ? scope.caps.judgeTotalUsd : undefined;
    const [check] = await tx.execute<{ global_ok: boolean; plan_ok: boolean; judge_ok: boolean }>(
      sql`
      with usage as (${usageQuery(scope)})
      select
        global_day + ${scope.amountUsd}::numeric <= ${scope.caps.globalDailyUsd}::numeric as global_ok,
        plan_day + ${scope.amountUsd}::numeric <= ${scope.caps.planDailyUsd}::numeric as plan_ok,
        ${judgeCap === undefined ? sql`true` : sql`judge_total + ${scope.amountUsd}::numeric <= ${judgeCap}::numeric`} as judge_ok
      from usage`,
    );
    if (!check) throw new Error('spend check returned no row');
    if (!check.global_ok) return { ok: false, reason: 'global_daily' } as const;
    if (!check.plan_ok) return { ok: false, reason: 'plan_daily' } as const;
    if (!check.judge_ok) return { ok: false, reason: 'judge_total' } as const;
    const [row] = await tx
      .insert(spendLedger)
      .values({
        planId: scope.planId,
        cycleId: scope.cycleId,
        ownerKind: scope.ownerKind,
        day: scope.day,
        amountUsd: scope.amountUsd,
        status: 'reserved',
      })
      .returning({ id: spendLedger.id });
    if (!row) throw new Error('spend reservation was not inserted');
    return { ok: true, ledgerId: row.id } as const;
  });
}

/** Confirms (`spent`, with the actual amount) or frees (`released`) a cycle's reservation. */
export async function settleSpend(
  db: Db,
  cycleId: number,
  status: 'spent' | 'released',
  amountUsd?: string,
): Promise<void> {
  await db
    .update(spendLedger)
    .set({ status, ...(amountUsd === undefined ? {} : { amountUsd }), updatedAt: sql`now()` })
    .where(eq(spendLedger.cycleId, cycleId));
}
