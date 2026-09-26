/**
 * House plans (SPEC §5.10, DECISIONS D-10: NVDA and QQQ on bStocks, Ondo as fallback). The seed
 * never overwrites a plan that exists: status, next due time and harvested interest belong to the
 * worker once a plan runs.
 *
 * Both plans start paused: the house wallet is not funded yet, and the funding amounts are human
 * money decisions (TASKS M0-11, REPLAN R1–R4). H-YIELD's principal is recorded from its deposit
 * receipt, not written here; the database refuses an active yield plan without one.
 */
import type { Db } from './index.js';
import { insertPlanIfMissing, type PlanInsert } from './plans.js';

export const AWAITING_FUNDING = 'awaiting_funding';

/** The two house plans, first due at `nextDueAt` (the next regular open + 2 minutes). */
export function housePlans(nextDueAt: string): PlanInsert[] {
  const common = {
    ownerKind: 'house',
    ownerRef: null,
    walletAddress: null,
    issuerPreference: ['bstocks', 'ondo'],
    window: 'regular_session',
    principalUsd: '0',
    status: 'paused',
    pausedReason: AWAITING_FUNDING,
    nextDueAt,
  } satisfies Partial<PlanInsert>;
  return [
    {
      ...common,
      id: 'H-SAFE',
      mode: 'safe',
      ticker: 'NVDA',
      contributionUsd: '5',
      cadence: 'daily',
      maxPerBuyUsd: '5',
      maxDailyUsd: '5',
    },
    {
      ...common,
      id: 'H-YIELD',
      mode: 'yield',
      ticker: 'QQQ',
      contributionUsd: '0',
      cadence: 'weekly',
      maxPerBuyUsd: '5',
      maxDailyUsd: '5',
    },
  ];
}

/** Inserts the house plans that are missing; returns which were created and which were kept. */
export async function seedHousePlans(
  db: Db,
  nextDueAt: string,
): Promise<{ created: string[]; kept: string[] }> {
  const created: string[] = [];
  const kept: string[] = [];
  for (const plan of housePlans(nextDueAt)) {
    ((await insertPlanIfMissing(db, plan)) ? created : kept).push(plan.id);
  }
  return { created, kept };
}
