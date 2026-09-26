/**
 * GET /api/market/status — the US session by our NYSE calendar and each registered token's last
 * recorded state (tape), with the data state (LIVE / STALE / UNAVAILABLE).
 */
import { context } from '../../../../lib/server/context';
import { json, unavailable } from '../../../../lib/server/http';
import { marketStatus } from '../../../../lib/server/market';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  return json(await marketStatus(db));
}
