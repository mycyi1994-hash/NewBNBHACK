/**
 * The house plans for the Watch screen and GET /api/house (SPEC §8.1): principal, interest so far
 * (the plan's vTokens at the on-chain rate minus its principal, read now), shares held, the next
 * buy, today's use of the limit, the receipt count and the last outcome with its reason.
 */
import type { Config } from '@yieldvest/config';
import { fromUnits, toUnits } from '@yieldvest/core';
import {
  holdingFromRow,
  isoTime,
  latestGuardianSamples,
  listCycles,
  listHoldings,
  listPlans,
  planFromRow,
  planSpendOnDay,
  readWorkerStatus,
  receipts,
  usdText,
  utcDay,
  type Db,
} from '@yieldvest/db';
import { inArray, sql } from 'drizzle-orm';
import { webChain } from './chain';

export interface Interest {
  state: 'LIVE' | 'UNAVAILABLE';
  usd: string | null;
  reason?: string;
  /** When the chain was read. */
  asOf?: string;
}

export interface VenusInfo {
  /** The API's display string without its "%" ("3.16"), shown as is — never recomputed from bps. */
  apy: string | null;
  /** When the DeFi API listed that APY (the worker refreshes it every six hours). */
  apyAt: string | null;
  securityScore: string | null;
  scoreAt: string | null;
  /** Both read within FRESH_MS: shown as current. Otherwise STALE (with the time) or hidden. */
  fresh: boolean;
}

/** The worker reads the rate every six hours: two missed reads make it stale. */
const FRESH_MS = 12 * 60 * 60_000;

export async function venusInfo(db: Db, now = new Date()): Promise<VenusInfo> {
  const [status, samples] = await Promise.all([
    readWorkerStatus(db, 'venus'),
    latestGuardianSamples(db),
  ]);
  const value = status?.value as { apyDisplay?: unknown; verifiedAt?: unknown } | undefined;
  const display = typeof value?.apyDisplay === 'string' ? value.apyDisplay.trim() : '';
  const apyAt = typeof value?.verifiedAt === 'string' ? value.verifiedAt : null;
  const scoreAt = samples.venus_security_score?.ts ?? null;
  const recent = (at: string | null) => at !== null && now.getTime() - Date.parse(at) <= FRESH_MS;
  return {
    apy: /^\d[\d,]*(\.\d+)?%$/.test(display) ? display.slice(0, -1) : null,
    apyAt,
    securityScore: samples.venus_security_score?.value ?? null,
    scoreAt,
    fresh: recent(apyAt) && recent(scoreAt),
  };
}

async function receiptCounts(db: Db, planIds: string[]): Promise<Map<string, number>> {
  if (planIds.length === 0) return new Map();
  const rows = await db
    .select({ planId: receipts.planId, n: sql<number>`count(*)::int` })
    .from(receipts)
    .where(inArray(receipts.planId, planIds))
    .groupBy(receipts.planId);
  return new Map(rows.map((r) => [r.planId, r.n]));
}

export async function houseView(db: Db, config: Config, now = new Date()) {
  const venus = (await readWorkerStatus(db, 'venus'))?.value as { vToken?: string } | undefined;
  const rows = await listPlans(db, { ownerKind: 'house' });
  const counts = await receiptCounts(
    db,
    rows.map((r) => r.id),
  );
  const plans = await Promise.all(
    rows.map(async (row) => {
      const plan = planFromRow(row);
      const [holdings, [last], usedToday] = await Promise.all([
        listHoldings(db, row.id),
        listCycles(db, { planIds: [row.id], limit: 1 }),
        planSpendOnDay(db, row.id, utcDay(now)),
      ]);
      let interest: Interest = { state: 'UNAVAILABLE', usd: null, reason: 'not a yield plan' };
      if (plan.mode === 'yield') {
        const vTokens = BigInt(row.vtokenUnits);
        if (vTokens === 0n) {
          interest = { state: 'UNAVAILABLE', usd: null, reason: 'no principal deposited yet' };
        } else if (!venus?.vToken) {
          interest = { state: 'UNAVAILABLE', usd: null, reason: 'Venus market not verified yet' };
        } else {
          try {
            const position = toUnits(await webChain(config).vTokensUsd(venus.vToken, vTokens), 18);
            const earned = position - toUnits(plan.principalUsd, 18);
            interest = {
              state: 'LIVE',
              usd: fromUnits(earned > 0n ? earned : 0n, 18),
              asOf: new Date().toISOString(),
            };
          } catch (error) {
            interest = {
              state: 'UNAVAILABLE',
              usd: null,
              reason:
                error instanceof Error
                  ? (error.message.split('\n')[0] ?? 'rpc error')
                  : 'rpc error',
            };
          }
        }
      }
      return {
        id: plan.id,
        mode: plan.mode,
        ticker: plan.target.type === 'ticker' ? plan.target.ticker : null,
        cadence: plan.cadence,
        window: plan.window,
        contributionUsd: plan.contributionUsd,
        status: plan.status,
        pausedReason: plan.pausedReason ?? null,
        principalUsd: plan.principalUsd,
        harvestedUnspentUsd: usdText(row.harvestedUnspentUsd),
        interest,
        nextDueAt: plan.nextDueAt,
        limits: {
          perBuyUsd: plan.limits.maxPerBuyUsd,
          perDayUsd: plan.limits.maxDailyUsd,
          usedTodayUsd: usdText(usedToday),
        },
        receiptCount: counts.get(row.id) ?? 0,
        holdings: holdings.map(holdingFromRow),
        last: last
          ? {
              at: isoTime(last.startedAt),
              state: last.state,
              outcome: last.outcomeKind,
              executionMode: last.executionMode,
              why: last.whyKey ? { key: last.whyKey, params: last.whyParams } : null,
            }
          : null,
      };
    }),
  );
  return { at: now.toISOString(), minBuyUsd: String(config.caps.minBuyUsd), plans };
}

export type HousePlan = Awaited<ReturnType<typeof houseView>>['plans'][number];
