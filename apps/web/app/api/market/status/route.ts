/**
 * GET /api/market/status — the US session by our NYSE calendar and each registered token's last
 * recorded state (tape), with the data state (LIVE / STALE / UNAVAILABLE).
 */
import { context } from '../../../../lib/server/context';
import { guard, json, unavailable } from '../../../../lib/server/http';
import { marketStatus } from '../../../../lib/server/market';

export const dynamic = 'force-dynamic';

async function handleGET(): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  return json(await marketStatus(db));
}

export const GET = guard('database', handleGET);
