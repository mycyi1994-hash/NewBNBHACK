import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BinanceClient, describeFailure } from './client.js';
import { broadcastSigned } from './endpoints.js';
import { BinanceApiError } from './errors.js';
import { createFixtureRecorder, type FixtureRecorder } from './fixtures.js';
import { MAX_RETRY_AFTER_MS, RateLimiter, type Clock } from './rate-limit.js';
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
  const limiter = new RateLimiter(undefined, clock);
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
    limiter,
    onApiCall: (r) => {
      records.push(r);
    },
    ...extra,
  });
  return { client, sent, records, clock, limiter };
}

const SUPPORTED_CHAINS = { method: 'GET', path: '/api/v1/dex/market/supported/chain' } as const;

/** Starts `server` on an ephemeral loopback port and returns its origin. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return `http://127.0.0.1:${address.port}`;
}

function rateLimited(retryAfter?: string): Response {
  return new Response(JSON.stringify({ code: 42900, msg: 'limited', data: null }), {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
  });
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

describe('describeFailure', () => {
  const failed = (cause?: unknown) =>
    new TypeError('fetch failed', cause === undefined ? {} : { cause });
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

  it('appends the cause of "fetch failed", with its code when the message lacks it', () => {
    expect(
      describeFailure(failed(coded('getaddrinfo ENOTFOUND web3.binance.com', 'ENOTFOUND'))),
    ).toBe('fetch failed (getaddrinfo ENOTFOUND web3.binance.com)');
    expect(describeFailure(failed(coded('certificate has expired', 'CERT_HAS_EXPIRED')))).toBe(
      'fetch failed (CERT_HAS_EXPIRED: certificate has expired)',
    );
    expect(describeFailure(failed(new Error('unexpected redirect')))).toBe(
      'fetch failed (unexpected redirect)',
    );
  });

  it('lists the attempts of an AggregateError (IPv6 and IPv4 both refused)', () => {
    const both = Object.assign(
      new AggregateError(
        [
          new Error('connect ECONNREFUSED ::1:443'),
          new Error('connect ECONNREFUSED 127.0.0.1:443'),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    );
    expect(describeFailure(failed(both))).toBe(
      'fetch failed (connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443)',
    );
    const bare = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(describeFailure(failed(bare))).toBe('fetch failed (ECONNREFUSED)');
  });

  it('keeps plain failures as they are', () => {
    expect(describeFailure(failed())).toBe('fetch failed');
    expect(describeFailure(failed('socket hang up\nat …'))).toBe('fetch failed (socket hang up)');
    expect(describeFailure('boom')).toBe('boom');
  });
});

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

  it('never signs two identical requests in the same millisecond alike (40103 replay)', async () => {
    // The fake clock stands still between requests, like two calls inside one millisecond.
    const { client, sent, records } = harness([new Response(OK([])), new Response(OK([]))]);
    await client.request('market', 'getSupportedChains', SUPPORTED_CHAINS);
    await client.request('market', 'getSupportedChains', SUPPORTED_CHAINS);
    expect(sent.map((s) => s.headers['x-oc-timestamp'])).toEqual([
      '2026-09-23T12:00:00.000Z',
      '2026-09-23T12:00:00.001Z',
    ]);
    expect(sent[1]!.headers['x-oc-sign']).not.toBe(sent[0]!.headers['x-oc-sign']);
    for (const request of sent) verifySignature(request);
    // api_calls.ts is the timestamp that was sent.
    expect(records.map((r) => r.ts)).toEqual([
      '2026-09-23T12:00:00.000Z',
      '2026-09-23T12:00:00.001Z',
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

  it('does not wait out a Retry-After beyond 30 s: one attempt, a retryable error with the wait', async () => {
    for (const [header, askedMs] of [
      ['3600', 3_600_000],
      ['2147484', 2_147_484_000], // past setTimeout's range: used to become a 1 ms sleep
    ] as const) {
      const { client, sent, clock, limiter } = harness([rateLimited(header)]);
      const started = clock.now();
      await expect(
        client.request('market', 'getSupportedChains', SUPPORTED_CHAINS),
      ).rejects.toMatchObject({
        code: 42900,
        httpStatus: 429,
        retryable: true,
        retryAfterMs: askedMs,
      });
      expect(sent).toHaveLength(1);
      expect(clock.now()).toBe(started); // nothing was slept
      // Every other call waits for the clamped pause only.
      expect(await limiter.acquire('GET /other')).toBe(MAX_RETRY_AFTER_MS);
    }
  });

  it('sends a request at most once when asked to, even after a 429', async () => {
    const { client, sent, limiter } = harness([rateLimited('2')]);
    await expect(
      client.request('market', 'getSupportedChains', {
        ...SUPPORTED_CHAINS,
        retryRateLimit: false,
      }),
    ).rejects.toMatchObject({ code: 42900, retryable: true, retryAfterMs: 2_000 });
    expect(sent).toHaveLength(1);
    // Everything else still pauses for the Retry-After.
    expect(await limiter.acquire('GET /other')).toBe(2_000);
  });

  it('broadcasts signed bytes with exactly one POST, even when rate-limited', async () => {
    const { client, sent, records } = harness([rateLimited('1')]);
    await expect(
      broadcastSigned(client, { address: WALLET, signedTransaction: '0x02f86b' }),
    ).rejects.toMatchObject({ code: 42900, retryable: true });
    expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'POST /build/api/v1/dex/pre-transaction/broadcast-transaction',
    ]);
    expect(records.map((r) => [r.endpoint, r.httpStatus, r.retryCount])).toEqual([
      ['broadcastTransactions', 429, 0],
    ]);
  });

  it('still retries a 429 whose Retry-After is exactly the 30 s limit', async () => {
    const { client, sent } = harness([rateLimited('30'), new Response(OK([]))]);
    const response = await client.request('market', 'getSupportedChains', SUPPORTED_CHAINS);
    expect(response.retryCount).toBe(1);
    expect(sent[1]!.headers['x-oc-timestamp']).toBe('2026-09-23T12:00:30.000Z');
  });

  it('does not sleep before retrying a transient failure whose Retry-After is too long', async () => {
    const unavailable = new Response(
      JSON.stringify({ code: 50001, msg: 'Service unavailable', data: null }),
      { status: 503, headers: { 'Retry-After': '120' } },
    );
    const { client, sent, clock } = harness([unavailable]);
    const started = clock.now();
    await expect(
      client.request('market', 'getSupportedChains', { ...SUPPORTED_CHAINS, retries: 2 }),
    ).rejects.toMatchObject({ code: 50001, retryable: true, retryAfterMs: 120_000 });
    expect(sent).toHaveLength(1);
    expect(clock.now()).toBe(started);
  });

  it('retries transient failures of idempotent calls with backoff, when asked', async () => {
    const serverError = () =>
      new Response(JSON.stringify({ code: 50000, msg: 'Internal server error', data: null }));
    const { client, records } = harness([
      serverError(),
      new TypeError('fetch failed'),
      new Response(OK([])),
    ]);
    const response = await client.request('market', 'getSupportedChains', {
      method: 'GET',
      path: '/api/v1/dex/market/supported/chain',
      retries: 2,
    });
    expect(response.retryCount).toBe(2);
    expect(records.map((r) => [r.code, r.retryCount, r.ts])).toEqual([
      ['50000', 0, '2026-09-23T12:00:00.000Z'],
      [null, 1, '2026-09-23T12:00:00.500Z'],
      ['0', 2, '2026-09-23T12:00:01.500Z'],
    ]);
  });

  it('stops after the allowed retries and never retries by default', async () => {
    const serverError = () =>
      new Response(JSON.stringify({ code: 50001, msg: 'Service unavailable', data: null }));
    const twice = harness([serverError(), serverError()]);
    await expect(
      twice.client.request('market', 'getSupportedChains', {
        method: 'GET',
        path: '/api/v1/dex/market/supported/chain',
        retries: 1,
      }),
    ).rejects.toMatchObject({ code: 50001, retryable: true });
    expect(twice.records).toHaveLength(2);

    const once = harness([serverError()]);
    await expect(
      once.client.request('market', 'getSupportedChains', {
        method: 'GET',
        path: '/api/v1/dex/market/supported/chain',
      }),
    ).rejects.toMatchObject({ code: 50001 });
    expect(once.records).toHaveLength(1);
  });

  it('does not retry a business error even when retries are allowed', async () => {
    const expired = JSON.stringify({ code: 40401, msg: 'expired', data: null });
    const { client, records } = harness([new Response(expired)]);
    await expect(
      client.request('trading', 'buildSwapTransaction', {
        method: 'GET',
        path: '/api/v1/dex/aggregator/swap',
        retries: 3,
      }),
    ).rejects.toMatchObject({ code: 40401, retryable: false });
    expect(records).toHaveLength(1);
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

  it('says why a request got no response, and keeps the cause on the error', async () => {
    // A port that was just freed: nothing listens there, so the connection is refused.
    const probe = createServer();
    const origin = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { client, records } = harness([], { baseUrl: `${origin}/build`, fetch });
    const error = await client
      .request('market', 'getSupportedChains', SUPPORTED_CHAINS)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'network', retryable: true });
    expect((error as BinanceApiError).cause).toBeInstanceOf(TypeError);
    expect(records[0]!.msg).toMatch(/^fetch failed \(connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/);
  });

  it('masks secrets that appear in a network failure cause', async () => {
    const cause = Object.assign(new Error(`proxy refused key ${KEY} for ${WALLET}`), {
      code: 'EPROXY',
    });
    const { client, records } = harness([new TypeError('fetch failed', { cause })]);
    await expect(
      client.request('market', 'getSupportedChains', SUPPORTED_CHAINS),
    ).rejects.toMatchObject({
      msg: 'fetch failed (EPROXY: proxy refused key [redacted] for 0x1111…1111)',
    });
    expect(records[0]!.msg).toBe(
      'fetch failed (EPROXY: proxy refused key [redacted] for 0x1111…1111)',
    );
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

  it('keeps a redacted address out of api_calls.msg and fixtures in every spelling', async () => {
    // Only the checksummed form is listed; calldata carries it bare and lowercase.
    const house = '0xAbCdEf0000000000000000000000000000000001';
    const bare = house.slice(2).toLowerCase();
    const calldata = `0x095ea7b3${'0'.repeat(24)}${bare}${'0'.repeat(58)}f4240`;
    const root = path.join(await mkdtemp(path.join(tmpdir(), 'ijaro-fixtures-')), 'fixtures');
    const reply = JSON.stringify({ code: 40001, msg: `bad calldata ${calldata}`, data: null });
    const { client, records } = harness([new Response(reply)], {
      redact: [house],
      fixtures: createFixtureRecorder({ rootDir: root }),
    });
    await client
      .request('transaction', 'simulateTransactions', {
        method: 'POST',
        path: '/api/v1/dex/pre-transaction/simulate',
        body: { binanceChainId: '56', evmTx: { from: house, data: calldata } },
        recordFixture: true,
      })
      .catch(() => undefined);
    expect(records[0]!.msg).toBe(
      `bad calldata 0x095ea7b3${'0'.repeat(24)}[redacted]${'0'.repeat(58)}f4240`,
    );
    const saved = await readFile(
      path.join(path.dirname(root), records[0]!.fixturePath ?? ''),
      'utf8',
    );
    expect(saved.toLowerCase()).not.toContain(bare);
  });

  it('never turns a processed request into an error when the fixture recorder fails', async () => {
    const diskFull = new Error('ENOSPC: no space left on device');
    const recorders: FixtureRecorder[] = [
      () => Promise.reject(diskFull),
      () => {
        throw diskFull;
      },
    ];
    for (const fixtures of recorders) {
      const sinkErrors: unknown[] = [];
      const { client, records } = harness([new Response(OK({ txHash: '0xabc', orderId: 'o-1' }))], {
        fixtures,
        recordAllFixtures: true,
        onSinkError: (e) => sinkErrors.push(e),
      });
      // The broadcast went through; losing its fixture must not make the executor think otherwise.
      await expect(
        broadcastSigned(client, { address: WALLET, signedTransaction: '0x02f86b' }),
      ).resolves.toEqual({ txHash: '0xabc', orderId: 'o-1' });
      expect(sinkErrors).toEqual([diskFull]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ httpStatus: 200, code: '0', fixturePath: null });
    }
  });

  it('waits a bounded time for a stuck api_calls sink or fixture recorder', async () => {
    const sinkErrors: unknown[] = [];
    const { client } = harness([new Response(OK([]))], {
      onApiCall: () => new Promise<void>(() => undefined),
      fixtures: () => new Promise<string>(() => undefined),
      recordAllFixtures: true,
      telemetryTimeoutMs: 20,
      onSinkError: (e) => sinkErrors.push(e),
    });
    const response = await client.request('market', 'getSupportedChains', SUPPORTED_CHAINS);
    expect(response.fixturePath).toBeNull();
    expect(sinkErrors.map((e) => (e as Error).message)).toEqual([
      'fixture recorder did not finish within 20 ms',
      'api_calls sink did not finish within 20 ms',
    ]);
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

  it('never follows a redirect: the key and signature stay with the configured origin', async () => {
    const reached: string[] = [];
    const elsewhere = createServer((req, res) => {
      reached.push(`${req.method} ${req.url} key=${String(req.headers['x-oc-apikey'])}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(OK('not ours'));
    });
    const elsewhereUrl = await listen(elsewhere);
    const gateway = createServer((_req, res) => {
      res.writeHead(302, { location: `${elsewhereUrl}/steal?userWalletAddress=${WALLET}` }).end();
    });
    const gatewayUrl = await listen(gateway);
    try {
      const { client, records } = harness([], { baseUrl: `${gatewayUrl}/build`, fetch });
      const error = await client
        .request('market', 'getSupportedChains', { ...SUPPORTED_CHAINS, retries: 2 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BinanceApiError);
      expect(error).toMatchObject({ kind: 'http', httpStatus: 302, code: null, retryable: false });
      expect(reached).toEqual([]);
      // Recorded once with its status, never retried, the Location masked.
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ httpStatus: 302, code: null });
      expect(records[0]!.msg).toContain('redirect not followed (HTTP 302 to http://127.0.0.1:');
      expect(records[0]!.msg).toContain('userWalletAddress=0x1111…1111');
    } finally {
      for (const server of [elsewhere, gateway]) {
        server.closeAllConnections();
        server.close();
      }
    }
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
