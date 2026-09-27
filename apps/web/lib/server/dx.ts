/**
 * The /dx numbers (TASKS M2-11), for the page and GET /api/dx/*: per-endpoint calls, p50/p95,
 * result codes and regions from api_calls; first sightings from dx_events; tape aggregates.
 * All measured by the worker; each block states how.
 */
import { summarizeCalls } from '@ijaro/binance';
import { isoTime, listApiCalls, listDxEvents, tapeSummary, type Db } from '@ijaro/db';

export const CALLS_METHOD =
  'every HTTP attempt the worker made to the Binance Web3 API (api_calls), latency measured around fetch';
export const TAPE_METHOD =
  'every 10 minutes the worker quotes $5/$50/$500 USDT → each registered token (never executed) and records the RWA status, token price and the independent US price (RWA Dynamic V2 stockInfo.price); gap = (token price ÷ multiplier) ÷ US price − 1, only where a US price existed';

/**
 * These numbers are public and read up to 30 days of rows: each window is computed at most once a
 * minute per server instance, however often it is asked for.
 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, work: () => Promise<T>): Promise<T> {
  const nowMs = Date.now();
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = work();
  cache.set(key, { at: nowMs, value });
  value.catch(() => cache.delete(key));
  return value;
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
