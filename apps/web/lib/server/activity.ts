/**
 * Activity (the Activity tab, receipt details, the Overview's interest story): what the plans did
 * and why, with the receipts that prove it. Yieldvest's own plans show every cycle — buys, waits and
 * skips with their reasons; any other plan shows the cycles that reached the chain. Deposits and
 * redeems outside a cycle are their own entries. Everything is read from the database the worker
 * writes; amounts come from receipts and cycle records, never from a quote or an estimate.
 */
import {
  cycles,
  isoTime,
  listReceipts,
  plans,
  receipts,
  usdText,
  type CycleRow,
  type Db,
  type PlanRow,
  type ReceiptRow,
} from '@yieldvest/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromBaseUnits } from '../format';

export interface ActivityReceipt {
  kind: string;
  txHash: string;
  explorerUrl: string;
  status: string;
  at: string;
  /** USDT this transaction moved, from the chain's Transfer logs when recorded; null for approvals. */
  usd: string | null;
}

export interface ActivityPlan {
  id: string;
  owner: string;
  mode: string;
  ticker: string;
  cadence: string;
  window: string;
  contributionUsd: string;
  status: string;
  pausedReason: string | null;
}

export interface ActivityItem {
  /** `cycle-<id>` or `tx-<hash>`. */
  key: string;
  cycleId: number | null;
  plan: ActivityPlan | null;
  at: string;
  /** BOUGHT, DEFERRED, SKIPPED, FAILED, SIMULATED, running — or deposit / redeem for a lone receipt. */
  kind: string;
  executionMode: string | null;
  why: { key: string; params: unknown } | null;
  spendUsd: string | null;
  interestUsd: string | null;
  shares: string | null;
  instrumentId: string | null;
  receipts: ActivityReceipt[];
}

const BASE_UNIT_KEYS = ['usdtSpent', 'usdt', 'usdtReceived', 'spentUsdtUnits'] as const;
const DECIMAL_KEYS = ['amountUsd', 'spendUsd'] as const;

/** The USDT a receipt moved: base units from the Transfer logs first, the requested amount after. */
export function receiptUsd(kind: string, amounts: unknown): string | null {
  if (kind === 'approve' || !amounts || typeof amounts !== 'object') return null;
  const record = amounts as Record<string, unknown>;
  for (const key of BASE_UNIT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && /^\d+$/.test(value) && value !== '0')
      return fromBaseUnits(value);
  }
  for (const key of DECIMAL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return value;
  }
  return null;
}

function planOf(row: PlanRow): ActivityPlan {
  return {
    id: row.id,
    owner: row.ownerKind,
    mode: row.mode,
    ticker: row.ticker,
    cadence: row.cadence,
    window: row.window,
    contributionUsd: usdText(row.contributionUsd),
    status: row.status,
    pausedReason: row.pausedReason ?? null,
  };
}

function receiptOf(row: ReceiptRow): ActivityReceipt {
  return {
    kind: row.kind,
    txHash: row.txHash,
    explorerUrl: row.explorerUrl,
    status: row.status,
    at: isoTime(row.createdAt),
    usd: receiptUsd(row.kind, row.amounts),
  };
}

function cycleKind(row: CycleRow): string {
  if (row.outcomeKind) return row.outcomeKind;
  const kind = (row.outcome as { kind?: unknown } | null)?.kind;
  return kind === 'SIMULATED' ? 'SIMULATED' : 'running';
}

function cycleItem(row: CycleRow, plan: PlanRow | undefined, own: ReceiptRow[]): ActivityItem {
  const outcome = (row.outcome ?? {}) as {
    kind?: string;
    spendUsd?: string;
    shares?: string;
    expectedShares?: string | null;
    interestUsd?: string | null;
  };
  const kind = cycleKind(row);
  return {
    key: `cycle-${row.id}`,
    cycleId: row.id,
    plan: plan ? planOf(plan) : null,
    at: isoTime(row.startedAt),
    kind,
    executionMode: row.executionMode,
    why: row.whyKey ? { key: row.whyKey, params: row.whyParams } : null,
    spendUsd:
      kind === 'BOUGHT' || kind === 'SIMULATED'
        ? (outcome.spendUsd ?? (row.spendUsd ? usdText(row.spendUsd) : null))
        : null,
    interestUsd: kind === 'BOUGHT' ? (outcome.interestUsd ?? null) : null,
    // A dry run records what it would have received; a buy, what the chain delivered.
    shares:
      kind === 'BOUGHT'
        ? (outcome.shares ?? null)
        : kind === 'SIMULATED'
          ? (outcome.expectedShares ?? null)
          : null,
    instrumentId: row.instrumentId ?? null,
    receipts: own.map(receiptOf),
  };
}

function receiptItem(row: ReceiptRow, plan: PlanRow | undefined): ActivityItem {
  const receipt = receiptOf(row);
  return {
    key: `tx-${row.txHash}`,
    cycleId: null,
    plan: plan ? planOf(plan) : null,
    at: receipt.at,
    kind: row.kind,
    executionMode: null,
    why: null,
    spendUsd: receipt.usd,
    interestUsd: null,
    shares: null,
    instrumentId: null,
    receipts: [receipt],
  };
}

/**
 * The newest `limit` entries: every cycle of Yieldvest's own plans, the cycles of other plans that
 * left a receipt, and receipts outside any cycle. A handful of queries, whatever the page size.
 */
export async function activityFeed(db: Db, limit = 60): Promise<ActivityItem[]> {
  const houseIds = (
    await db.select({ id: plans.id }).from(plans).where(eq(plans.ownerKind, 'house'))
  ).map((p) => p.id);
  const [houseCycles, recent] = await Promise.all([
    houseIds.length > 0
      ? db
          .select()
          .from(cycles)
          .where(inArray(cycles.planId, houseIds))
          .orderBy(desc(cycles.startedAt), desc(cycles.id))
          .limit(limit)
      : Promise.resolve([] as CycleRow[]),
    listReceipts(db, { limit }),
  ]);
  const known = new Set(houseCycles.map((c) => c.id));
  const otherIds = [
    ...new Set(recent.flatMap((r) => (r.cycleId && !known.has(r.cycleId) ? [r.cycleId] : []))),
  ];
  const otherCycles =
    otherIds.length > 0
      ? await db.select().from(cycles).where(inArray(cycles.id, otherIds))
      : ([] as CycleRow[]);
  const allCycles = [...houseCycles, ...otherCycles];
  const cycleIds = allCycles.map((c) => c.id);
  const planIds = [...new Set([...allCycles.map((c) => c.planId), ...recent.map((r) => r.planId)])];
  const [cycleReceipts, planRows] = await Promise.all([
    cycleIds.length > 0
      ? db
          .select()
          .from(receipts)
          .where(inArray(receipts.cycleId, cycleIds))
          .orderBy(receipts.createdAt, receipts.id)
      : Promise.resolve([] as ReceiptRow[]),
    planIds.length > 0
      ? db.select().from(plans).where(inArray(plans.id, planIds))
      : Promise.resolve([] as PlanRow[]),
  ]);
  const planById = new Map(planRows.map((p) => [p.id, p]));
  const receiptsOf = new Map<number, ReceiptRow[]>();
  for (const row of cycleReceipts) {
    if (row.cycleId === null) continue;
    receiptsOf.set(row.cycleId, [...(receiptsOf.get(row.cycleId) ?? []), row]);
  }
  const cycleIdSet = new Set(cycleIds);
  const items = [
    ...allCycles.map((c) => cycleItem(c, planById.get(c.planId), receiptsOf.get(c.id) ?? [])),
    ...recent
      .filter((r) => r.cycleId === null || !cycleIdSet.has(r.cycleId))
      .map((r) => receiptItem(r, planById.get(r.planId))),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** One plan's history: its cycles with their receipts, and its receipts outside any cycle. */
export async function planActivity(db: Db, plan: PlanRow, limit = 100): Promise<ActivityItem[]> {
  const [own, planReceipts] = await Promise.all([
    db
      .select()
      .from(cycles)
      .where(eq(cycles.planId, plan.id))
      .orderBy(desc(cycles.startedAt), desc(cycles.id))
      .limit(limit),
    db
      .select()
      .from(receipts)
      .where(eq(receipts.planId, plan.id))
      .orderBy(receipts.createdAt, receipts.id)
      .limit(limit * 3),
  ]);
  const ids = new Set(own.map((c) => c.id));
  const receiptsOf = new Map<number, ReceiptRow[]>();
  for (const row of planReceipts) {
    if (row.cycleId === null || !ids.has(row.cycleId)) continue;
    receiptsOf.set(row.cycleId, [...(receiptsOf.get(row.cycleId) ?? []), row]);
  }
  const items = [
    ...own.map((c) => cycleItem(c, plan, receiptsOf.get(c.id) ?? [])),
    ...planReceipts
      .filter((r) => r.cycleId === null || !ids.has(r.cycleId))
      .map((r) => receiptItem(r, plan)),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Totals over every recorded buy and receipt, for the Activity summary. */
export async function activityTotals(db: Db) {
  const [[bought], [onchain]] = await Promise.all([
    db
      .select({
        n: sql<number>`count(*)::int`,
        usd: sql<string>`coalesce(sum(${cycles.spendUsd}), 0)::text`,
        last: sql<string | null>`max(${cycles.startedAt})::text`,
      })
      .from(cycles)
      .where(eq(cycles.outcomeKind, 'BOUGHT')),
    db.select({ n: sql<number>`count(*)::int` }).from(receipts),
  ]);
  return {
    purchases: bought?.n ?? 0,
    boughtUsd: usdText(bought?.usd ?? '0'),
    lastPurchaseAt: bought?.last ? isoTime(bought.last) : null,
    receipts: onchain?.n ?? 0,
  };
}

/**
 * One cycle with its plan and receipts, for the public receipt page. The same rule as the feed:
 * a cycle of Yieldvest's own plans, or one that reached the chain. Cycle ids are sequential, so a
 * judge's or an assistant's cycle that left no receipt (a dry run, a wait) stays off this page —
 * its owner sees it on the plan's own page, whose id is not guessable.
 */
export async function cycleDetail(db: Db, id: number) {
  const [row] = await db.select().from(cycles).where(eq(cycles.id, id)).limit(1);
  if (!row) return undefined;
  const [[plan], own] = await Promise.all([
    db.select().from(plans).where(eq(plans.id, row.planId)).limit(1),
    db
      .select()
      .from(receipts)
      .where(eq(receipts.cycleId, id))
      .orderBy(receipts.createdAt, receipts.id),
  ]);
  if (plan?.ownerKind !== 'house' && own.length === 0) return undefined;
  return {
    item: cycleItem(row, plan, own),
    steps: Array.isArray(row.steps) ? (row.steps as Record<string, unknown>[]) : [],
    finishedAt: row.finishedAt ? isoTime(row.finishedAt) : null,
    state: row.state,
  };
}

/**
 * A yield plan's interest story for the Overview flow and the Earn chart: what its interest has
 * bought so far (from its BOUGHT cycles), when it started earning (its first deposit receipt), when
 * the interest now in its position began to accrue (its latest deposit or redeem: each one resets
 * what the position holds above principal) and its latest buy.
 */
export async function interestStory(db: Db, planId: string) {
  const [[spent], firstDeposit, lastReset, [lastBuy]] = await Promise.all([
    db
      .select({
        usd: sql<string>`coalesce(sum(${cycles.interestUsd}), 0)::text`,
        n: sql<number>`count(*)::int`,
      })
      .from(cycles)
      .where(and(eq(cycles.planId, planId), eq(cycles.outcomeKind, 'BOUGHT'))),
    db
      .select({ at: receipts.createdAt })
      .from(receipts)
      .where(and(eq(receipts.planId, planId), eq(receipts.kind, 'deposit')))
      .orderBy(receipts.createdAt)
      .limit(1),
    db
      .select({ at: receipts.createdAt })
      .from(receipts)
      .where(and(eq(receipts.planId, planId), inArray(receipts.kind, ['deposit', 'redeem'])))
      .orderBy(desc(receipts.createdAt))
      .limit(1),
    db
      .select()
      .from(cycles)
      .where(and(eq(cycles.planId, planId), eq(cycles.outcomeKind, 'BOUGHT')))
      .orderBy(desc(cycles.startedAt), desc(cycles.id))
      .limit(1),
  ]);
  return {
    spentUsd: usdText(spent?.usd ?? '0'),
    purchases: spent?.n ?? 0,
    since: firstDeposit[0] ? isoTime(firstDeposit[0].at) : null,
    cycleStart: lastReset[0] ? isoTime(lastReset[0].at) : null,
    lastBuyCycleId: lastBuy?.id ?? null,
  };
}

export type InterestStory = Awaited<ReturnType<typeof interestStory>>;
