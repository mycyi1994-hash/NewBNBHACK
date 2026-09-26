/**
 * Guardian history (PLAN §7): samples of the inputs whose rules look back in time, and the open
 * verdicts decideCycle honours. Values are numeric(38,18) text.
 */
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import { guardianEvents, guardianSamples } from './schema.js';

export type GuardianMetric = 'venus_tvl_usd' | 'usdt_price_usd' | 'venus_utilization_bps';

export async function insertGuardianSample(
  db: Db,
  sample: { ts: string; metric: GuardianMetric; value: string; source: string },
): Promise<void> {
  await db.insert(guardianSamples).values(sample);
}

/** The sample of `source` closest to `at` within ±`toleranceMs`, or undefined. */
export async function sampleNear(
  db: Db,
  metric: GuardianMetric,
  source: string,
  at: Date,
  toleranceMs: number,
): Promise<{ ts: string; value: string } | undefined> {
  const from = new Date(at.getTime() - toleranceMs).toISOString();
  const to = new Date(at.getTime() + toleranceMs).toISOString();
  const [row] = await db
    .select({ ts: guardianSamples.ts, value: guardianSamples.value })
    .from(guardianSamples)
    .where(
      and(
        eq(guardianSamples.metric, metric),
        eq(guardianSamples.source, source),
        gte(guardianSamples.ts, from),
        lte(guardianSamples.ts, to),
      ),
    )
    .orderBy(sql`abs(extract(epoch from ${guardianSamples.ts} - ${at.toISOString()}::timestamptz))`)
    .limit(1);
  return row;
}

/**
 * When the metric went below `threshold` and has stayed there: the first sample after the last one
 * at or above it. Undefined when the latest sample is not below the threshold (or there is none).
 */
export async function belowSince(
  db: Db,
  metric: GuardianMetric,
  source: string,
  threshold: string,
): Promise<string | undefined> {
  const [latest] = await db
    .select({ ts: guardianSamples.ts, value: guardianSamples.value })
    .from(guardianSamples)
    .where(and(eq(guardianSamples.metric, metric), eq(guardianSamples.source, source)))
    .orderBy(desc(guardianSamples.ts))
    .limit(1);
  if (!latest) return undefined;
  const rows = await db.execute<{ since: string | null; below: boolean }>(sql`
    select
      ${latest.value}::numeric < ${threshold}::numeric as below,
      (select min(ts)::text from guardian_samples
        where metric = ${metric} and source = ${source}
          and ts > coalesce(
            (select max(ts) from guardian_samples
              where metric = ${metric} and source = ${source} and value >= ${threshold}::numeric),
            '-infinity'::timestamptz)) as since`);
  const [row] = rows;
  return row?.below && row.since ? row.since : undefined;
}

/** Open guardian verdicts that apply to a plan: global ones and the plan's own. */
export async function openGuardianActions(
  db: Db,
  planId?: string,
): Promise<{ rule: string; action: string }[]> {
  const rows = await db
    .select({
      rule: guardianEvents.rule,
      action: guardianEvents.action,
      planId: guardianEvents.planId,
    })
    .from(guardianEvents)
    .where(isNull(guardianEvents.resolvedAt))
    .orderBy(asc(guardianEvents.ts));
  return rows
    .filter((row) => row.planId === null || row.planId === planId)
    .map(({ rule, action }) => ({ rule, action }));
}
