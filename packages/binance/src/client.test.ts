import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BinanceClient } from './client.js';
import { BinanceApiError } from './errors.js';
import { createFixtureRecorder } from './fixtures.js';
import { RateLimiter, type Clock } from './rate-limit.js';
import { preHash, signPreHash } from './sign.js';
import type { ApiCallRecord } from './telemetry.js';

const BASE = 'https://web3.binance.com/build';
const KEY = 'test-api-key-0123';
const SECRET = 'test-secret-4567';
const WALLET = '0x1111111111111111111111111111111111111111';
const OK = (data: unknown, timestamp = 0) =>
  JSON.stringify({ code: 0, msg: 'success', data, timestamp, success: true });

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeClock(start = Date.parse('2026-09-23T12:00:00.000Z')): Clock {
  let now = start;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

function harness(
  responses: (Response | Error)[],
  extra: Partial<ConstructorParameters<typeof BinanceClient>[0]> = {},
) {
  const sent: Sent[] = [];
  const records: ApiCallRecord[] = [];
  const clock = fakeClock();
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const client = new BinanceClient({
    baseUrl: BASE,
    apiKey: KEY,
    apiSecret: SECRET,
    region: 'kr-dev',
    fetch: fetchImpl,
    clock,
    limiter: new RateLimiter(undefined, clock),
    onApiCall: (r) => {
      records.push(r);
    },
    ...extra,
  });
  return { client, sent, records };
}

function verifySignature(request: Sent) {
  const url = new URL(request.url);
  const expected = signPreHash(
    SECRET,
    preHash({
      timestamp: request.headers['x-oc-timestamp'] ?? '',
      method: request.method,
      requestPath: `${url.pathname}${url.search}`,
      body: request.body ?? '',
    }),
  );
  expect(request.headers['x-oc-sign']).toBe(expected);
}

describe('BinanceClient.request', () => {
  it('signs exactly the path and query that go on the wire, with /build', async () => {
    const { client, sent, records } = harness([new Response(OK([{ tokenSymbol: 'X' }]))]);
    const response = await client.request<{ tokenSymbol: string }[]>('rwa', 'getRwaTokenList', {
      method: 'GET',
      path: '/api/v1/dex/market/rwa/tokens',
      query: { binanceChainId: '56' },
    });
    expect(response.data).toEqual([{ tokenSymbol: 'X' }]);
    expect(sent[0]!.url).toBe(`${BASE}/api/v1/dex/market/rwa/tokens?binanceChainId=56`);
    expect(sent[0]!.headers['x-oc-apikey']).toBe(KEY);
    expect(sent[0]!.headers['x-oc-timestamp']).toBe('2026-09-23T12:00:00.000Z');
    verifySignature(sent[0]!);
    expect(records).toEqual([
      {
        ts: '2026-09-23T12:00:00.000Z',
        region: 'kr-dev',
        module: 'rwa',
        endpoint: 'getRwaTokenList',
        method: 'GET',
        httpStatus: 200,
        code: '0',
        msg: 'success',
        latencyMs: 0,
        requestId: null,
        retryCount: 0,
        fixturePath: null,
      },
    ]);
  });

  it('sends and signs the same JSON body bytes for POST', async () => {
    const { client, sent } = harness([new Response(OK({ dataList: [] }))]);
    await client.request('defi-transaction', 'buildDeFiDepositTransaction', {
      method: 'POST',
      path: '/api/v1/defi/transaction/deposit',
      body: { address: WALLET, investmentId: 'id', token: { tokenAddress: WALLET, amount: '10' } },
    });
    expect(sent[0]!.headers['content-type']).toBe('application/json');
    expect(sent[0]!.body).toBe(
      `{"address":"${WALLET}","investmentId":"id","token":{"tokenAddress":"${WALLET}","amount":"10"}}`,
    );
    verifySignature(sent[0]!);
  });

  it('raises HTTP-200 business errors as BinanceApiError', async () => {
    const body = JSON.stringify({
      code: 40401,
      msg: 'Quote expired. Please request a new quote',
      data: null,
    });
    const { client, records } = harness([new Response(body, { status: 200 })]);
    const error = await client
      .request('trading', 'buildSwapTransaction', {
        method: 'GET',
        path: '/api/v1/dex/aggregator/swap',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BinanceApiError);
    expect(error).toMatchObject({ kind: 'api', httpStatus: 200, code: 40401, retryable: false });
    expect(records[0]).toMatchObject({ httpStatus: 200, code: '40401' });
  });

  it('honours Retry-After on 429 and retries once with a fresh signature', async () => {
    const limited = () =>
      new Response(
        JSON.stringify({
          code: 42900,
          msg: 'Request rate limit exceeded',
          data: null,
          timestamp: 0,
        }),
        {
          status: 429,
          headers: { 'Retry-After': '2' },
        },
      );
    const { client, sent, records } = harness([limited(), new Response(OK([]))]);
    const response = await client.request('market', 'getSupportedChains', {
      method: 'GET',
      path: '/api/v1/dex/market/supported/chain',
    });
    expect(response.retryCount).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers['x-oc-timestamp']).toBe('2026-09-23T12:00:02.000Z');
    expect(sent[1]!.headers['x-oc-sign']).not.toBe(sent[0]!.headers['x-oc-sign']);
    verifySignature(sent[1]!);
    expect(records.map((r) => [r.httpStatus, r.retryCount])).toEqual([
      [429, 0],
      [200, 1],
    ]);
  });

  it('gives up after the second 429 with a retryable error', async () => {
    const limited = () =>
      new Response(JSON.stringify({ code: 42900, msg: 'limited', data: null }), { status: 429 });
    const { client } = harness([limited(), limited()]);
    await expect(
      client.request('market', 'getSupportedChains', {
        method: 'GET',
        path: '/api/v1/dex/market/supported/chain',
      }),
    ).rejects.toMatchObject({ code: 42900, retryable: true, httpStatus: 429 });
  });

  it('refuses a signed call without credentials, before any network I/O', async () => {
    const { client, sent } = harness([], { apiKey: undefined, apiSecret: undefined });
    await expect(
      client.request('rwa', 'getRwaTokenList', {
        method: 'GET',
        path: '/api/v1/dex/market/rwa/tokens',
      }),
    ).rejects.toMatchObject({ kind: 'config' });
    expect(sent).toHaveLength(0);
  });

  it('sends no auth headers on unsigned probes', async () => {
    const body = JSON.stringify({ code: 40101, msg: 'Invalid API Key', data: null, timestamp: 0 });
    const { client, sent } = harness([new Response(body, { status: 401 })], {
      apiKey: undefined,
      apiSecret: undefined,
    });
    await expect(
      client.request('market', 'getSupportedChains', {
        method: 'GET',
        path: '/api/v1/dex/market/supported/chain',
        signed: false,
      }),
    ).rejects.toMatchObject({ httpStatus: 401, code: 40101 });
    expect(Object.keys(sent[0]!.headers).filter((h) => h.startsWith('x-oc-'))).toEqual([]);
  });

  it('records network failures with no HTTP status', async () => {
    const { client, records } = harness([new TypeError('fetch failed')]);
    await expect(
      client.request('wallet', 'getWalletSupportedChains', {
        method: 'GET',
        path: '/api/v1/dex/balance/supported/chain',
      }),
    ).rejects.toMatchObject({ kind: 'network', retryable: true });
    expect(records[0]).toMatchObject({ httpStatus: null, code: null, msg: 'fetch failed' });
  });

  it('masks keys and wallet addresses in api_calls.msg', async () => {
    const body = JSON.stringify({ code: 40001, msg: `bad key ${KEY} for ${WALLET}`, data: null });
    const { client, records } = harness([new Response(body)]);
    await client
      .request('wallet', 'getAllTokenBalancesByAddress', {
        method: 'GET',
        path: '/api/v1/dex/balance/all-token-balances-by-address',
      })
      .catch(() => undefined);
    expect(records[0]!.msg).toBe('bad key [redacted] for 0x1111…1111');
  });

  it('warns when the server clock drifts from ours', async () => {
    const skews: number[] = [];
    const serverTime = Date.parse('2026-09-23T12:00:03.000Z');
    const { client } = harness([new Response(OK([], serverTime))], {
      onClockSkew: (ms) => skews.push(ms),
    });
    const response = await client.request('market', 'getSupportedChains', {
      method: 'GET',
      path: '/api/v1/dex/market/supported/chain',
    });
    expect(response.clockSkewMs).toBe(3_000);
    expect(skews).toEqual([3_000]);
  });

  it('never sends a GET body', async () => {
    const { client } = harness([]);
    await expect(
      client.request('trading', 'getRfqOrderStatus', {
        method: 'GET',
        path: '/api/v1/dex/aggregator/order/{orderId}',
        pathParams: { orderId: 'o-1' },
        body: { orderId: 'o-1' },
      }),
    ).rejects.toMatchObject({ kind: 'config' });
  });

  it('records fixtures with our wallet and key redacted, numbered per day', async () => {
    const root = path.join(await mkdtemp(path.join(tmpdir(), 'ijaro-fixtures-')), 'fixtures');
    // The recorder only knows the wallet; the client adds its own key/secret to the redact list.
    const fixtures = createFixtureRecorder({ rootDir: root, redact: [WALLET] });
    const reply = () =>
      new Response(OK({ holder: WALLET.toUpperCase().replace('0X', '0x'), echo: KEY, big: 1 }), {
        headers: { 'content-type': 'application/json', 'x-oc-ratelimit-remaining': '1199' },
      });
    const { client, records } = harness([reply(), reply()], { fixtures });
    for (let i = 0; i < 2; i++) {
      await client.request('wallet', 'getAllTokenBalancesByAddress', {
        method: 'GET',
        path: '/api/v1/dex/balance/all-token-balances-by-address',
        query: { binanceChainId: '56', address: WALLET },
        recordFixture: true,
      });
    }
    expect(records.map((r) => r.fixturePath)).toEqual([
      'fixtures/wallet/getAllTokenBalancesByAddress-20260923-1.json',
      'fixtures/wallet/getAllTokenBalancesByAddress-20260923-2.json',
    ]);
    expect(await readdir(path.join(root, 'wallet'))).toHaveLength(2);
    const saved = await readFile(
      path.join(root, 'wallet', 'getAllTokenBalancesByAddress-20260923-1.json'),
      'utf8',
    );
    expect(saved).not.toContain(WALLET.slice(2));
    expect(saved).not.toContain(KEY);
    expect(JSON.parse(saved)).toMatchObject({
      module: 'wallet',
      endpoint: 'getAllTokenBalancesByAddress',
      request: {
        method: 'GET',
        path: '/build/api/v1/dex/balance/all-token-balances-by-address?binanceChainId=56&address=[redacted]',
      },
      response: {
        httpStatus: 200,
        headers: { 'x-oc-ratelimit-remaining': '1199' },
        body: { code: 0, data: { holder: '[redacted]', echo: '[redacted]', big: 1 } },
      },
    });
  });
});
