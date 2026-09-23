/**
 * Integration test against a real Postgres. Runs when IJARO_TEST_DATABASE_URL points at a
 * disposable database (CI starts one); never point it at a shared database.
 */
import { randomUUID } from 'node:crypto';
import type { ApiCallRecord } from '@ijaro/binance';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCalls, createApiCallSink, createDb, listApiCalls, migrateDb } from './index.js';

const url = process.env.IJARO_TEST_DATABASE_URL;

describe.skipIf(!url)('api_calls on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const endpoint = `test-${randomUUID()}`;

  beforeAll(async () => {
    await migrateDb(db);
    await migrateDb(db); // idempotent
  });
  afterAll(async () => {
    await db.delete(apiCalls).where(eq(apiCalls.endpoint, endpoint));
    await close();
  });

  it('stores what the client hook emits and reads it back unchanged', async () => {
    const records: ApiCallRecord[] = [
      {
        ts: '2026-09-23T12:00:00.123Z',
        region: 'fra',
        module: 'rwa',
        endpoint,
        method: 'GET',
        httpStatus: 200,
        code: '0',
        msg: 'success',
        latencyMs: 87,
        requestId: 'req-1',
        retryCount: 0,
        fixturePath: 'fixtures/rwa/getRwaTokenList-20260923-1.json',
      },
      {
        ts: '2026-09-23T12:00:01.000Z',
        region: null,
        module: 'b402',
        endpoint,
        method: 'POST',
        httpStatus: null,
        code: null,
        msg: 'fetch failed',
        latencyMs: 15000,
        requestId: null,
        retryCount: 1,
        fixturePath: null,
      },
    ];
    const sink = createApiCallSink(db);
    for (const record of records) await sink(record);

    const stored = (await listApiCalls(db, new Date('2026-09-23T00:00:00Z'))).filter(
      (r) => r.endpoint === endpoint,
    );
    expect(stored).toEqual(records);
  });
});
