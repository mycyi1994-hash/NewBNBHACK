/**
 * GET /api/judge/smoke (SPEC §8.2, TASKS M2-12): everything a judge's visit depends on, in one
 * read — database, the worker's last tick, the Web3 API as the worker last saw it (the web never
 * calls it), BSC RPC, the house balances, the last receipt and the tape. `status` is green when
 * every check passes, degraded when something is stale, red when something is down (HTTP 503).
 */
import { fromUnits } from '@ijaro/core';
import { apiCalls, isoTime, listReceipts, readWorkerStatus, type Db } from '@ijaro/db';
import { desc, sql } from 'drizzle-orm';
import { webChain } from '../../../../lib/server/chain';
import { context } from '../../../../lib/server/context';
import { json } from '../../../../lib/server/http';
import { tapeView } from '../../../../lib/server/market';

export const dynamic = 'force-dynamic';

type Check = { state: 'green' | 'degraded' | 'red'; detail: Record<string, unknown> };

const TICK_FRESH_MS = 15 * 60_000;
const API_FRESH_MS = 30 * 60_000;

/** Integer units the worker wrote as a string; anything else reads as zero. */
const units = (value: unknown): bigint =>
  typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n;

/**
 * Runs one check. A failure is reported as a label only: error messages can carry a database host
 * or an RPC URL with a key in it, and this endpoint is public. The message goes to the server log.
 */
async function timed<T>(
  label: string,
  work: () => Promise<T>,
): Promise<{ value?: T; ms: number; error?: string }> {
  const started = Date.now();
  try {
    return { value: await work(), ms: Date.now() - started };
  } catch (error) {
    console.error(`smoke: ${label} —`, error instanceof Error ? error.message : error);
    return { ms: Date.now() - started, error: `${label} unreachable` };
  }
}

export async function GET(): Promise<Response> {
  const now = new Date();
  const { config, db } = context();
  const checks: Record<string, Check> = {};
  if (!db) {
    return json(
      {
        status: 'red',
        at: now.toISOString(),
        checks: { database: { state: 'red', detail: { reason: 'no DATABASE_URL' } } },
      },
      503,
    );
  }
  const rpc = await timed('rpc', () => webChain(config).blockNumber());
  checks.rpc = rpc.error
    ? { state: 'red', detail: { error: rpc.error } }
    : { state: 'green', detail: { block: rpc.value?.toString(), ms: rpc.ms } };

  const ping = await timed('database', () => db.execute(sql`select 1`));
  if (ping.error) {
    // Everything else lives in the database: report what is known and stop.
    checks.database = { state: 'red', detail: { error: ping.error } };
    return json({ status: 'red', at: now.toISOString(), checks }, 503);
  }
  checks.database = { state: 'green', detail: { ms: ping.ms } };
  try {
    await databaseChecks(db, now, checks);
  } catch (error) {
    console.error('smoke: database —', error instanceof Error ? error.message : error);
    checks.database = { state: 'red', detail: { error: 'database unreachable' } };
    return json({ status: 'red', at: now.toISOString(), checks }, 503);
  }

  const states = Object.values(checks).map((c) => c.state);
  const status = states.includes('red')
    ? 'red'
    : states.includes('degraded')
      ? 'degraded'
      : 'green';
  return json({ status, at: now.toISOString(), checks }, status === 'red' ? 503 : 200);
}

/** The worker, Web3 API, house, receipt and tape checks — all read from what the worker records. */
async function databaseChecks(db: Db, now: Date, checks: Record<string, Check>): Promise<void> {
  const tick = await readWorkerStatus(db, 'tick');
  const tickAge = tick ? now.getTime() - Date.parse(isoTime(tick.updatedAt)) : null;
  checks.worker = !tick
    ? { state: 'red', detail: { reason: 'no tick recorded' } }
    : {
        state: tickAge !== null && tickAge <= TICK_FRESH_MS ? 'green' : 'red',
        detail: {
          lastTick: isoTime(tick.updatedAt),
          mode: tick.value.mode,
          errors: tick.value.errors,
        },
      };

  const [lastOk] = await db
    .select({ ts: apiCalls.ts, endpoint: apiCalls.endpoint, latencyMs: apiCalls.latencyMs })
    .from(apiCalls)
    .where(sql`${apiCalls.code} = '0'`)
    .orderBy(desc(apiCalls.ts))
    .limit(1);
  const [lastCall] = await db
    .select({ ts: apiCalls.ts, code: apiCalls.code, httpStatus: apiCalls.httpStatus })
    .from(apiCalls)
    .orderBy(desc(apiCalls.ts))
    .limit(1);
  const okAge = lastOk ? now.getTime() - Date.parse(isoTime(lastOk.ts)) : null;
  checks.web3api = !lastOk
    ? { state: 'red', detail: { reason: 'no successful call recorded' } }
    : {
        state: okAge !== null && okAge <= API_FRESH_MS ? 'green' : 'degraded',
        detail: {
          lastSuccess: isoTime(lastOk.ts),
          endpoint: lastOk.endpoint,
          latencyMs: lastOk.latencyMs,
          lastCall: lastCall
            ? { at: isoTime(lastCall.ts), code: lastCall.code, httpStatus: lastCall.httpStatus }
            : null,
        },
      };

  const house = await readWorkerStatus(db, 'house');
  checks.house = !house
    ? { state: 'degraded', detail: { reason: 'no balance recorded' } }
    : {
        state: 'green',
        detail: {
          usdt: fromUnits(units(house.value.usdtUnits), 18),
          bnb: fromUnits(units(house.value.bnbWei), 18),
          at: house.value.at,
        },
      };

  const [receipt] = await listReceipts(db, { limit: 1 });
  checks.receipts = receipt
    ? {
        state: 'green',
        detail: {
          last: {
            kind: receipt.kind,
            txHash: receipt.txHash,
            explorerUrl: receipt.explorerUrl,
            at: isoTime(receipt.createdAt),
          },
        },
      }
    : { state: 'degraded', detail: { reason: 'no receipt yet' } };

  const tape = await tapeView(db, now);
  checks.tape = {
    state: tape.state === 'LIVE' ? 'green' : tape.state === 'STALE' ? 'degraded' : 'red',
    detail: { state: tape.state, sampledAt: tape.sampledAt, ageSeconds: tape.ageSeconds },
  };
}
