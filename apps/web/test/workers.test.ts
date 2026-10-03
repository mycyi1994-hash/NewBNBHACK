/**
 * apps/web on Cloudflare Workers (G2-2), with the runtime check and the OpenNext adapter's request
 * context replaced: a database pool per request (a socket belongs to the request that opened it),
 * the client address Cloudflare sets rather than one the client can send, and caches that share
 * only finished results across requests (a pending promise belongs to the request that started it).
 */
import { loadConfig } from '@yieldvest/config';
import type { Db } from '@yieldvest/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { context, resetContext } from '../lib/server/context';
import { dxMetrics } from '../lib/server/dx';
import { clientIp } from '../lib/server/http';
import { ensureJudgeCodes, resetJudgeCodeSync } from '../lib/server/judge';

/** The request the code under test runs in: one ExecutionContext object per request. */
const cloudflare = vi.hoisted((): { ctx: object } => ({ ctx: {} }));
vi.mock('../lib/server/runtime', () => ({ onWorkers: true }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: {}, cf: undefined, ctx: cloudflare.ctx }),
}));

/** The database reads behind the shared caches, each held until the test settles it. */
const held = vi.hoisted(() => ({
  calls: [] as { resolve: (rows: []) => void; reject: (error: Error) => void }[],
  syncs: [] as ((count: number) => void)[],
}));
vi.mock('@yieldvest/db', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listApiCalls: () =>
    new Promise((resolve, reject) => {
      held.calls.push({ resolve, reject });
    }),
  listDxEvents: () => Promise.resolve([]),
  syncJudgeCodes: () =>
    new Promise((resolve) => {
      held.syncs.push(resolve);
    }),
}));

describe('clientIp on Workers', () => {
  const spoofed = { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.8, 10.0.0.1' };

  it('reads cf-connecting-ip, never the x-real-ip or x-forwarded-for a client can send', () => {
    const request = new Request('https://yieldvest.test/api/judge/session', {
      headers: { ...spoofed, 'cf-connecting-ip': '198.51.100.4' },
    });
    expect(clientIp(request)).toBe('198.51.100.4');
  });

  it('is unknown without cf-connecting-ip', () => {
    expect(clientIp(new Request('https://yieldvest.test/', { headers: spoofed }))).toBe('unknown');
  });
});

describe('context on Workers', () => {
  const databaseUrl = process.env.DATABASE_URL;

  afterEach(async () => {
    process.env.DATABASE_URL = databaseUrl;
    await resetContext();
  });

  it('gives each request its own pool, and every call within a request the same one', async () => {
    // postgres.js connects on the first query only; nothing here queries.
    process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:9/never';
    await resetContext();
    cloudflare.ctx = {};
    const first = context().db;
    expect(first).toBeDefined();
    expect(context().db).toBe(first);
    cloudflare.ctx = {};
    const second = context().db;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(context().config.databaseUrl).toBe('postgres://nobody@127.0.0.1:9/never');
  });

  it('has no pool without DATABASE_URL', async () => {
    process.env.DATABASE_URL = '';
    await resetContext();
    expect(context().db).toBeUndefined();
  });
});

describe('caches shared across requests on Workers', () => {
  const db = {} as Db;

  it('/dx numbers: no request waits on another one’s read; a finished result is shared', async () => {
    const first = dxMetrics(db, 3);
    const second = dxMetrics(db, 3);
    expect(held.calls).toHaveLength(2);
    // The first read fails: nothing is cached, and the other request is unaffected.
    held.calls[0]?.reject(new Error('connection reset'));
    await expect(first).rejects.toThrow('connection reset');
    held.calls[1]?.resolve([]);
    const result = await second;
    expect(result.method).toMatch(/api_calls/);
    // A request within the minute gets the finished result, without a read of its own.
    expect(await dxMetrics(db, 3)).toEqual(result);
    expect(held.calls).toHaveLength(2);
  });

  it('judge codes: each request syncs until one sync has finished, then none does', async () => {
    resetJudgeCodeSync();
    const config = { ...loadConfig(), judgeCodes: ['CODE-A', 'CODE-B'] };
    const first = ensureJudgeCodes(db, config);
    const second = ensureJudgeCodes(db, config);
    expect(held.syncs).toHaveLength(2);
    held.syncs[1]?.(2);
    expect(await second).toBe(2);
    expect(await ensureJudgeCodes(db, config)).toBe(2);
    expect(held.syncs).toHaveLength(2);
    held.syncs[0]?.(2);
    expect(await first).toBe(2);
    resetJudgeCodeSync();
  });
});
