import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiCallRecord, ApiCallSink, ApiModule } from '@ijaro/binance';
import { asc, gte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { apiCalls } from './schema.js';

export { apiCalls };

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 5, onnotice: () => undefined });
  const db = drizzle(sql);
  return { db, close: () => sql.end({ timeout: 5 }) };
}

export type Db = ReturnType<typeof createDb>['db'];

export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS });
}

export async function insertApiCall(db: Db, record: ApiCallRecord): Promise<void> {
  await db.insert(apiCalls).values(record);
}

/** The Binance client's `onApiCall` hook, backed by Postgres. */
export function createApiCallSink(db: Db): ApiCallSink {
  return (record) => insertApiCall(db, record);
}

export async function listApiCalls(db: Db, since?: Date): Promise<ApiCallRecord[]> {
  const rows = await db
    .select()
    .from(apiCalls)
    .where(since ? gte(apiCalls.ts, since.toISOString()) : undefined)
    .orderBy(asc(apiCalls.ts), asc(apiCalls.id));
  return rows.map(({ id: _id, ...row }) => ({
    ...row,
    ts: new Date(row.ts).toISOString(),
    module: row.module as ApiModule,
  }));
}
