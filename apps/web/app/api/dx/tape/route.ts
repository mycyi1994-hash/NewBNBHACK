/**
 * GET /api/dx/tape?days=7 — tape aggregates for the /dx charts (TASKS M2-11): regular session vs
 * off-hours price gap, price impact by quote size, issuer comparison. Method in `method`.
 */
import { tapeSummary } from '@ijaro/db';
import { context } from '../../../../lib/server/context';
import { intParam, json, unavailable } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const days = intParam(request, 'days', 7, 1, 30);
  const since = new Date(Date.now() - days * 86_400_000);
  return json({
    generatedAt: new Date().toISOString(),
    since: since.toISOString(),
    method:
      'every 10 minutes the worker quotes $5/$50/$500 USDT → each registered token (never executed) and records the RWA status, token price and the independent US price (RWA Dynamic V2 stockInfo.price); gap = (token price ÷ multiplier) ÷ US price − 1, only where a US price existed',
    rows: await tapeSummary(db, since),
  });
}
