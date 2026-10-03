/**
 * apps/web on Cloudflare Workers (G2-2), with the runtime check and the OpenNext adapter's request
 * context replaced: a database pool per request (a socket belongs to the request that opened it),
 * and the client address Cloudflare sets rather than one the client can send.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { context, resetContext } from '../lib/server/context';
import { clientIp } from '../lib/server/http';

/** The request the code under test runs in: one ExecutionContext object per request. */
const cloudflare = vi.hoisted((): { ctx: object } => ({ ctx: {} }));
vi.mock('../lib/server/runtime', () => ({ onWorkers: true }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: {}, cf: undefined, ctx: cloudflare.ctx }),
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
