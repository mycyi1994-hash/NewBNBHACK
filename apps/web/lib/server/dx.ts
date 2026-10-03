/**
 * The /dx numbers (TASKS M2-11), for the page and GET /api/dx/*: per-endpoint calls, p50/p95,
 * result codes and regions from api_calls; first sightings from dx_events; tape aggregates.
 * All measured by the worker; each block states how.
 */
import { summarizeCalls } from '@yieldvest/binance';
import {
  isoTime,
  listApiCalls,
  listDxEvents,
  TAPE_METHOD,
  tapeSummary,
  type Db,
} from '@yieldvest/db';
import { onWorkers } from './runtime';

export const CALLS_METHOD =
  'every HTTP attempt the worker made to the Binance Web3 API (api_calls), latency measured around fetch';
export { TAPE_METHOD };

/**
 * These numbers are public and read up to 30 days of rows: each window is computed at most once a
 * minute per server instance, however often it is asked for. A Node server also shares the
 * computation in flight; on Workers a pending promise belongs to the request that started it
 * (runtime.ts), so other requests get only its finished result.
 */
const CACHE_MS = 60_000;
type Entry = { at: number; pending: Promise<unknown> } | { at: number; result: unknown };
const cache = new Map<string, Entry>();

function cached<T>(key: string, work: () => Promise<T>): Promise<T> {
  const nowMs = Date.now();
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS)
    return 'pending' in hit ? (hit.pending as Promise<T>) : Promise.resolve(hit.result as T);
  const pending = work();
  const entry: Entry = { at: nowMs, pending };
  if (!onWorkers) cache.set(key, entry);
  return pending.then(
    (result) => {
      cache.set(key, { at: nowMs, result });
      return result;
    },
    (error: unknown) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    },
  );
}

export function dxMetrics(db: Db, days: number, now = new Date()) {
  return cached(`metrics:${days}`, () => computeMetrics(db, days, now));
}

export function dxTape(db: Db, days: number, now = new Date()) {
  return cached(`tape:${days}`, () => computeTape(db, days, now));
}

async function computeMetrics(db: Db, days: number, now: Date) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [calls, events] = await Promise.all([listApiCalls(db, since), listDxEvents(db)]);
  return {
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    method: CALLS_METHOD,
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
  };
}

async function computeTape(db: Db, days: number, now: Date) {
  const since = new Date(now.getTime() - days * 86_400_000);
  return {
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    method: TAPE_METHOD,
    rows: await tapeSummary(db, since),
  };
}

export type DxMetrics = Awaited<ReturnType<typeof dxMetrics>>;
export type DxTape = Awaited<ReturnType<typeof dxTape>>;

/** Average gap per session across sizes and issuers, weighted by how many samples had a US price. */
export function gapBySession(
  rows: DxTape['rows'],
): { session: string; gapPct: number | null; samples: number }[] {
  const bySession = new Map<string, { sum: number; n: number }>();
  for (const row of rows) {
    const entry = bySession.get(row.session) ?? { sum: 0, n: 0 };
    if (row.avgGapPct !== null && row.gapSamples > 0) {
      entry.sum += Number(row.avgGapPct) * row.gapSamples;
      entry.n += row.gapSamples;
    }
    bySession.set(row.session, entry);
  }
  return ['regular', 'pre', 'post', 'overnight', 'weekend', 'holiday']
    .filter((session) => bySession.has(session))
    .map((session) => {
      const { sum, n } = bySession.get(session) ?? { sum: 0, n: 0 };
      return { session, gapPct: n > 0 ? sum / n : null, samples: n };
    });
}

/** Regular-session gap against every other session together (the home insight card). */
export function sessionGapSummary(rows: DxTape['rows']): {
  regular: number | null;
  offHours: number | null;
} {
  let regular = { sum: 0, n: 0 };
  let off = { sum: 0, n: 0 };
  for (const row of rows) {
    if (row.avgGapPct === null || row.gapSamples === 0) continue;
    const add = { sum: Number(row.avgGapPct) * row.gapSamples, n: row.gapSamples };
    if (row.session === 'regular') regular = { sum: regular.sum + add.sum, n: regular.n + add.n };
    else off = { sum: off.sum + add.sum, n: off.n + add.n };
  }
  return {
    regular: regular.n > 0 ? regular.sum / regular.n : null,
    offHours: off.n > 0 ? off.sum / off.n : null,
  };
}
