/**
 * Server-side context for route handlers: validated config and one database pool per server
 * instance. The web never holds a signing key and never calls the Binance Web3 API: it reads what
 * the worker wrote and queues jobs (SPEC §5 v2) — one API key used from one region only (Q-01).
 */
import { loadConfig, type Config } from '@ijaro/config';
import { createDb, type Db } from '@ijaro/db';

let cached: { config: Config; db: Db | undefined; close: () => Promise<void> } | undefined;

export function context(): { config: Config; db: Db | undefined } {
  if (!cached) {
    const config = loadConfig();
    const database = config.databaseUrl ? createDb(config.databaseUrl) : undefined;
    cached = { config, db: database?.db, close: database?.close ?? (() => Promise.resolve()) };
  }
  return cached;
}

/** Tests: drop the cached context so a changed environment is read again. */
export async function resetContext(): Promise<void> {
  const current = cached;
  cached = undefined;
  await current?.close();
}
