/**
 * Drizzle schema. M0 ships only `api_calls` (SPEC §3.1 item 2, §10); the other tables of SPEC §4
 * arrive with M1-01.
 */
import { bigserial, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** One row per HTTP attempt to the Binance Web3 API, written by the client's onApiCall hook. */
export const apiCalls = pgTable(
  'api_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** X-OC-TIMESTAMP sent with the request (what Binance support asks for). */
    ts: timestamp('ts', { withTimezone: true, mode: 'string' }).notNull(),
    region: text('region'),
    module: text('module').notNull(),
    endpoint: text('endpoint').notNull(),
    method: text('method').notNull(),
    httpStatus: integer('http_status'),
    /** Envelope code as text: OC codes are numbers, B402 codes are strings. */
    code: text('code'),
    /** Masked: keys redacted, addresses shortened. */
    msg: text('msg'),
    latencyMs: integer('latency_ms').notNull(),
    requestId: text('request_id'),
    retryCount: integer('retry_count').notNull().default(0),
    fixturePath: text('fixture_path'),
  },
  (table) => [
    index('api_calls_ts_idx').on(table.ts),
    index('api_calls_endpoint_idx').on(table.module, table.endpoint),
  ],
);
