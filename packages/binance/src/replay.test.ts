/**
 * Recorded responses replayed through the client and the taxonomy (SPEC §12 v2, M1-07): 40401
 * expired quote, 42900 rate limit (HTTP 429), 40375 Ondo minimum, 40484 DeFi revert, and a
 * simulation that fails inside code 0. The fixtures are the real bytes from 2026-09-24.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BinanceClient } from './client.js';
import { BinanceApiError } from './errors.js';
import { parseJsonLossless, stringifyJsonLossless } from './json.js';
import { RateLimiter, type Clock } from './rate-limit.js';
import { requireSimulationSuccess, SimulationFailedError } from './simulation.js';
import { venueMinimumUsd } from './taxonomy.js';
import type { ApiCallRecord } from './telemetry.js';

const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', 'fixtures');

interface Fixture {
  request: { method: 'GET' | 'POST'; path: string };
  response: { httpStatus: number; headers: Record<string, string>; body: unknown };
}

function load(file: string): Fixture {
  return parseJsonLossless(readFileSync(path.join(FIXTURES, file), 'utf8')) as Fixture;
}

function asResponse(fixture: Fixture): Response {
  const { httpStatus, headers, body } = fixture.response;
  const text = typeof body === 'string' ? body : stringifyJsonLossless(body);
  return new Response(text, { status: httpStatus, headers });
}

function replay(files: string[]) {
  let now = Date.parse('2026-09-24T00:46:00.000Z');
  const slept: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
  const responses = files.map((f) => asResponse(load(f)));
  const records: ApiCallRecord[] = [];
  const client = new BinanceClient({
    baseUrl: 'https://web3.binance.com/build',
    apiKey: 'k',
    apiSecret: 's',
    clock,
    limiter: new RateLimiter(undefined, clock),
    fetch: () => {
      const next = responses.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error('no fixture left'));
    },
    onApiCall: (r) => {
      records.push(r);
    },
  });
  return { client, records, slept };
}

/** The request as the fixture recorded it (path without /build, query kept). */
function requestOf(file: string) {
  const { request } = load(file);
  const url = new URL(request.path.replace(/^\/build/, ''), 'https://x');
  return {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
  };
}

async function failure(promise: Promise<unknown>): Promise<BinanceApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BinanceApiError) return error;
    throw error;
  }
  throw new Error('expected a BinanceApiError');
}

describe('fixture replay', () => {
  it('40401 expired quote → re-quote, nothing retried', async () => {
    const file = 'trading/buildSwapTransaction-20260924-2.json';
    const { client, records } = replay([file]);
    const error = await failure(client.request('trading', 'buildSwapTransaction', requestOf(file)));
    expect(error).toMatchObject({ code: 40401, httpStatus: 200, retryable: false });
    expect(error.msg).toMatch(/not found or expired/);
    expect(error.classify()).toMatchObject({ action: 'requote', alert: false, documented: true });
    expect(records).toHaveLength(1);
  });

  it('40375 Ondo minimum → next issuer, with the minimum read from the message', async () => {
    const file = 'trading/getAggregatedQuote-20260924-4.json';
    const { client } = replay([file]);
    const error = await failure(client.request('trading', 'getAggregatedQuote', requestOf(file)));
    expect(error.classify()).toMatchObject({
      action: 'next_issuer',
      userKey: 'why.skipped.below_min',
    });
    expect(venueMinimumUsd(error.msg)).toBe('5');
  });

  it('42900 over HTTP 429 → waits Retry-After, retries once with a new signature', async () => {
    const limited = 'trading/getAggregatedQuote-20260924-12.json';
    const ok = 'trading/getAggregatedQuote-20260924-1.json';
    const { client, records } = replay([limited, ok]);
    const response = await client.request('trading', 'getAggregatedQuote', requestOf(limited));
    expect(response.retryCount).toBe(1);
    expect(records.map((r) => [r.httpStatus, r.code, r.retryCount])).toEqual([
      [429, '42900', 0],
      [200, '0', 1],
    ]);
    // The second attempt waited for the 1 s Retry-After.
    expect(
      Date.parse(records[1]?.ts ?? '') - Date.parse(records[0]?.ts ?? ''),
    ).toBeGreaterThanOrEqual(1_000);
  });

  it('42900 twice → a retryable error that carries the wait', async () => {
    const limited = 'trading/getAggregatedQuote-20260924-12.json';
    const { client } = replay([limited, limited]);
    const error = await failure(
      client.request('trading', 'getAggregatedQuote', requestOf(limited)),
    );
    expect(error).toMatchObject({
      code: 42900,
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 1_000,
    });
    expect(error.classify().action).toBe('retry');
  });

  it('40484 DeFi preview revert → the cycle fails, no funds moved, no retry', async () => {
    const file = 'defi-transaction/buildDeFiDepositTransaction-20260924-1.json';
    const { client, records } = replay([file]);
    const { request } = load(file);
    const error = await failure(
      client.request('defi-transaction', 'buildDeFiDepositTransaction', {
        method: request.method,
        path: '/api/v1/defi/transaction/deposit',
        body: {},
        retries: 2,
      }),
    );
    expect(error.classify()).toMatchObject({
      action: 'fail',
      userKey: 'why.failed.simulation',
      documented: true,
    });
    expect(records).toHaveLength(1);
  });

  it('simulate FAILED inside code 0 → refused before signing', async () => {
    const failed = 'transaction/simulateTransactions-20260924-2.json';
    const { client } = replay([failed]);
    const response = await client.request('transaction', 'simulateTransactions', {
      method: 'POST',
      path: '/api/v1/dex/pre-transaction/simulate',
      body: {},
    });
    expect(response.code).toBe(0);
    expect(() => requireSimulationSuccess(response.data)).toThrow(SimulationFailedError);
    expect(() => requireSimulationSuccess(response.data)).toThrow(
      'simulation FAILED: execution reverted: BEP20: transfer amount exceeds balance',
    );
  });

  it('simulate SUCCESS → allowance changes are readable (here: the unlimited DeFi approve, Q-16)', async () => {
    const success = 'transaction/simulateTransactions-20260924-1.json';
    const { client } = replay([success]);
    const response = await client.request('transaction', 'simulateTransactions', {
      method: 'POST',
      path: '/api/v1/dex/pre-transaction/simulate',
      body: {},
    });
    const result = requireSimulationSuccess(response.data);
    expect(result.allowanceChanges).toHaveLength(1);
    expect(BigInt(result.allowanceChanges[0]?.postAmount ?? '0')).toBe(2n ** 256n - 1n);
  });
});
