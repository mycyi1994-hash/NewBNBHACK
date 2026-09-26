/**
 * GET /api/dx/metrics?days=7 — per-endpoint call counts, p50/p95, result codes and regions from
 * api_calls, and the first sightings of undocumented codes (TASKS M2-11). Measured by the worker.
 */
import { summarizeCalls } from '@ijaro/binance';
import { isoTime, listApiCalls, listDxEvents } from '@ijaro/db';
import { context } from '../../../../lib/server/context';
import { intParam, json, unavailable } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const days = intParam(request, 'days', 7, 1, 30);
  const since = new Date(Date.now() - days * 86_400_000);
  const calls = await listApiCalls(db, since);
  const events = await listDxEvents(db);
  return json({
    generatedAt: new Date().toISOString(),
    since: since.toISOString(),
    method: 'every HTTP attempt the worker made to the Binance Web3 API (api_calls), latency measured around fetch',
    ...summarizeCalls(calls),
    findings: events.map((e) => ({
      at: isoTime(e.ts),
      kind: e.kind,
      module: e.module,
      endpoint: e.endpoint,
      code: e.code,
      httpStatus: e.httpStatus,
      meaning: e.meaning,
      logged: e.loggedAt !== null,
    })),
  });
}
