/**
 * GET /api/tape/latest (TASKS M0-08, SPEC §7): the most recent tape run from tape_samples.
 * Data state per CLAUDE.md rule 4: LIVE (run within two intervals), STALE (older, with its
 * timestamp) or UNAVAILABLE (with a reason). Read-only.
 */
import { loadConfig } from '@ijaro/config';
import { createDb, latestTapeSamples } from '@ijaro/db';

export const dynamic = 'force-dynamic';

/** Two tape intervals (10 min each): one missed run is still LIVE, two are STALE. */
const LIVE_WITHIN_MS = 2 * 10 * 60 * 1000;

export async function GET(): Promise<Response> {
  const config = loadConfig();
  if (!config.databaseUrl) {
    return Response.json({ state: 'UNAVAILABLE', reason: 'no DATABASE_URL' }, { status: 503 });
  }
  const { db, close } = createDb(config.databaseUrl);
  try {
    const rows = await latestTapeSamples(db);
    const first = rows[0];
    if (!first) {
      return Response.json(
        { state: 'UNAVAILABLE', reason: 'no tape samples yet' },
        { status: 503 },
      );
    }
    const ageMs = Date.now() - Date.parse(first.sampledAt);
    return Response.json({
      state: ageMs <= LIVE_WITHIN_MS ? 'LIVE' : 'STALE',
      sampledAt: new Date(first.sampledAt).toISOString(),
      slotAt: new Date(first.slotAt).toISOString(),
      ageSeconds: Math.round(ageMs / 1000),
      rows,
    });
  } catch {
    return Response.json({ state: 'UNAVAILABLE', reason: 'database error' }, { status: 503 });
  } finally {
    await close();
  }
}
