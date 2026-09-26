/** GET /api/instruments — the verified registry (addresses from the RWA API, checked on chain, D-07). */
import { instrumentFromRow, listInstruments } from '@ijaro/db';
import { context } from '../../../lib/server/context';
import { guard, json, unavailable } from '../../../lib/server/http';

export const dynamic = 'force-dynamic';

async function handleGET(): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  return json({ instruments: (await listInstruments(db)).map(instrumentFromRow) });
}

export const GET = guard('database', handleGET);
