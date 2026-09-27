/**
 * GET /api/dx/metrics?days=7 — per-endpoint call counts, p50/p95, result codes and regions from
 * api_calls, and the first sightings of undocumented codes (TASKS M2-11). Measured by the worker.
 */
import { context } from '../../../../lib/server/context';
import { dxMetrics } from '../../../../lib/server/dx';
import { guard, intParam, json, unavailable } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

async function handleGET(request: Request): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  return json(await dxMetrics(db, intParam(request, 'days', 7, 1, 30)));
}

export const GET = guard('database', handleGET);
