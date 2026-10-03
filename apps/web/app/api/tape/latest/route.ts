/**
 * GET /api/tape/latest (TASKS M0-08, SPEC §7): the most recent tape run from tape_samples.
 * Data state per CLAUDE.md rule 4: LIVE (run within two intervals), STALE (older, with its
 * timestamp) or UNAVAILABLE (with a reason). Read-only.
 */
import { context } from '../../../../lib/server/context';
import { json, unavailable } from '../../../../lib/server/http';
import { tapeView } from '../../../../lib/server/market';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  try {
    const tape = await tapeView(db, new Date());
    if (tape.state === 'UNAVAILABLE') return unavailable('no market data recorded yet');
    return json(tape);
  } catch {
    return unavailable('database error');
  }
}
