/**
 * Server-side context for route handlers: validated config and one database pool per server
 * instance (per request on Cloudflare Workers, below). The web never holds a signing key and never
 * calls the Binance Web3 API: it reads what the worker wrote and queues jobs (SPEC §5 v2) — one API
 * key used from one region only (Q-01).
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { loadConfig, type Config } from '@yieldvest/config';
import { createDb, type Db } from '@yieldvest/db';
import { onWorkers } from './runtime';

let cached: { config: Config; db: Db | undefined; close: () => Promise<void> } | undefined;

/**
 * Cloudflare Workers (G2-2): a socket belongs to the request that opened it, and a request that
 * waits on another request's socket hangs until the runtime cancels it. So there a pool lives as
 * long as one request, keyed by that request's ExecutionContext; the runtime closes its sockets
 * when the request ends.
 */
const requestPools = new WeakMap<object, Db>();

function requestPool(databaseUrl: string): Db {
  const { ctx } = getCloudflareContext<Record<string, unknown>, object>();
  let db = requestPools.get(ctx);
  if (!db) {
    db = createDb(databaseUrl).db;
    requestPools.set(ctx, db);
  }
  return db;
}

export function context(): { config: Config; db: Db | undefined } {
  if (!cached) {
    const config = loadConfig();
    const database = config.databaseUrl && !onWorkers ? createDb(config.databaseUrl) : undefined;
    cached = { config, db: database?.db, close: database?.close ?? (() => Promise.resolve()) };
  }
  const { config } = cached;
  if (onWorkers && config.databaseUrl) return { config, db: requestPool(config.databaseUrl) };
  return cached;
}

/** Tests: drop the cached context so a changed environment is read again. */
export async function resetContext(): Promise<void> {
  const current = cached;
  cached = undefined;
  await current?.close();
}
