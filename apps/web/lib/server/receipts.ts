/** The receipt feed (Watch screen, GET /api/receipts): every on-chain action with its reason. */
import { cycles, isoTime, listReceipts, plans, type Db } from '@yieldvest/db';
import { inArray } from 'drizzle-orm';

export async function receiptFeed(db: Db, limit: number) {
  const rows = await listReceipts(db, { limit });
  // Three reads for the whole page, not two per receipt.
  const cycleIds = [...new Set(rows.flatMap((r) => (r.cycleId ? [r.cycleId] : [])))];
  const planIds = [...new Set(rows.map((r) => r.planId))];
  const [cycleRows, planRows] = await Promise.all([
    cycleIds.length > 0
      ? db.select().from(cycles).where(inArray(cycles.id, cycleIds))
      : Promise.resolve([]),
    planIds.length > 0
      ? db.select().from(plans).where(inArray(plans.id, planIds))
      : Promise.resolve([]),
  ]);
  const cycleOf = new Map(cycleRows.map((c) => [c.id, c]));
  const planOf = new Map(planRows.map((p) => [p.id, p]));
  return rows.map((r) => {
    const cycle = r.cycleId ? cycleOf.get(r.cycleId) : undefined;
    const plan = planOf.get(r.planId);
    return {
      planId: r.planId,
      owner: plan?.ownerKind ?? null,
      mode: plan?.mode ?? null,
      ticker: plan?.ticker ?? null,
      kind: r.kind,
      txHash: r.txHash,
      explorerUrl: r.explorerUrl,
      amounts: r.amounts,
      broadcastVia: r.broadcastVia,
      status: r.status,
      /** The Wallet API's view of the transaction (D-34), as the worker stored it; null until read. */
      indexed: r.indexed ?? null,
      at: isoTime(r.createdAt),
      outcome: cycle?.outcomeKind ?? null,
      why: cycle?.whyKey ? { key: cycle.whyKey, params: cycle.whyParams } : null,
    };
  });
}

export type FeedItem = Awaited<ReturnType<typeof receiptFeed>>[number];
