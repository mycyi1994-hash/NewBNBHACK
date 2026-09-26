/**
 * GET /api/house — the two house plans for the Watch screen (SPEC §8.1): principal, interest so
 * far (read on chain), shares held, the next buy, today's use of the limit and the last outcome.
 */
import { context } from '../../../lib/server/context';
import { json, unavailable } from '../../../lib/server/http';
import { houseView } from '../../../lib/server/house';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  return json(await houseView(db, config));
}
