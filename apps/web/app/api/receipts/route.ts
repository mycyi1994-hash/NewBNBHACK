/** GET /api/receipts?limit=20 — the receipt feed: every on-chain action with its one-line reason. */
import { context } from '../../../lib/server/context';
import { intParam, json, unavailable } from '../../../lib/server/http';
import { receiptFeed } from '../../../lib/server/receipts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const limit = intParam(request, 'limit', 20, 1, 100);
  return json({ at: new Date().toISOString(), receipts: await receiptFeed(db, limit) });
}
