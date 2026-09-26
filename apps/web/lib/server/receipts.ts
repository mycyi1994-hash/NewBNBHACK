/** The receipt feed (Watch screen, GET /api/receipts): every on-chain action with its reason. */
import { getCycle, getPlan, isoTime, listReceipts, type Db } from '@ijaro/db';

export async function receiptFeed(db: Db, limit: number) {
  const rows = await listReceipts(db, { limit });
  return Promise.all(
    rows.map(async (r) => {
      const [cycle, plan] = await Promise.all([
        r.cycleId ? getCycle(db, r.cycleId) : undefined,
        getPlan(db, r.planId),
      ]);
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
        at: isoTime(r.createdAt),
        outcome: cycle?.outcomeKind ?? null,
        why: cycle?.whyKey ? { key: cycle.whyKey, params: cycle.whyParams } : null,
      };
    }),
  );
}

export type FeedItem = Awaited<ReturnType<typeof receiptFeed>>[number];
