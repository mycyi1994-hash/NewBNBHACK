/** GET /api/receipts?limit=20 — the receipt feed: every on-chain action with its one-line reason. */
import { getCycle, getPlan, isoTime, listReceipts } from '@ijaro/db';
import { context } from '../../../lib/server/context';
import { intParam, json, unavailable } from '../../../lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const limit = intParam(request, 'limit', 20, 1, 100);
  const receipts = await listReceipts(db, { limit });
  const feed = await Promise.all(
    receipts.map(async (r) => {
      const [cycle, plan] = await Promise.all([
        r.cycleId ? getCycle(db, r.cycleId) : undefined,
        getPlan(db, r.planId),
      ]);
      return {
        planId: r.planId,
        owner: plan?.ownerKind ?? null,
        ticker: plan?.ticker ?? null,
        kind: r.kind,
        txHash: r.txHash,
        explorerUrl: r.explorerUrl,
        amounts: r.amounts,
        broadcastVia: r.broadcastVia,
        status: r.status,
        at: isoTime(r.createdAt),
        why: cycle?.whyKey ? { key: cycle.whyKey, params: cycle.whyParams } : null,
      };
    }),
  );
  return json({ at: new Date().toISOString(), receipts: feed });
}
