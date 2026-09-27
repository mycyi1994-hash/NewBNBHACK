/**
 * GET /api/dx/tape?days=7 — tape aggregates for the /dx charts (TASKS M2-11): regular session vs
 * off-hours price gap, price impact by quote size, issuer comparison. Method in `method`.
 */
import { context } from '../../../../lib/server/context';
import { dxTape } from '../../../../lib/server/dx';
import { guard, intParam, json, unavailable } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

async function handleGET(request: Request): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  return json(await dxTape(db, intParam(request, 'days', 7, 1, 30)));
}

export const GET = guard('database', handleGET);
