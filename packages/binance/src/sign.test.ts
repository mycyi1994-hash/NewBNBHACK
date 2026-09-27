import { describe, expect, it } from 'vitest';
import {
  MAX_RECV_WINDOW_MS,
  authHeaders,
  buildTarget,
  encodeQuery,
  encodeRfc3986,
  fillPathParams,
  formatTimestamp,
  increasingTimestamps,
  preHash,
  signPreHash,
} from './sign.js';

describe('query encoding', () => {
  const samples = [
    "McDonald's",
    'ETH USDT',
    'a+b=c&d',
    '100% (!*)',
    'Société Générale €5',
    '📈 NVDA',
    '~-._',
    '0x55d398326f99059fF775485246999027B3197955',
  ];

  it.each(samples)('is left untouched by URL parsing: %s', (value) => {
    const target = buildTarget('https://web3.binance.com/build', '/api/v1/x', { q: value });
    const parsed = new URL(target.url);
    expect(`${parsed.pathname}${parsed.search}`).toBe(target.requestPath);
    expect(new URLSearchParams(parsed.search).get('q')).toBe(value);
  });

  it('encodes the apostrophe that encodeURIComponent leaves raw (URL would send %27)', () => {
    expect(encodeURIComponent("'")).toBe("'");
    expect(encodeRfc3986("'")).toBe('%27');
    expect(new URL("https://h/p?q='").search).toBe('?q=%27');
  });

  it('keeps insertion order and drops null/undefined', () => {
    expect(encodeQuery({ b: 2, a: 'x y', skip: undefined, none: null, t: true })).toBe(
      'b=2&a=x%20y&t=true',
    );
  });
});

describe('buildTarget', () => {
  it('prefixes the base path (/build) that must be signed (V-01, V-02)', () => {
    expect(
      buildTarget('https://web3.binance.com/build', '/api/v1/dex/market/rwa/tokens', {
        binanceChainId: '56',
      }),
    ).toEqual({
      url: 'https://web3.binance.com/build/api/v1/dex/market/rwa/tokens?binanceChainId=56',
      requestPath: '/build/api/v1/dex/market/rwa/tokens?binanceChainId=56',
    });
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildTarget('https://web3.binance.com/build/', '/api/v1/x').requestPath).toBe(
      '/build/api/v1/x',
    );
  });

  it('refuses paths that URL parsing would rewrite', () => {
    expect(() => buildTarget('https://h/build', '/api/../v1')).toThrow('rewritten on the wire');
    expect(() => buildTarget('https://h/build', 'api/v1')).toThrow('must start with');
  });

  it('shortens wallet addresses in its errors', () => {
    const wallet = '0x55d398326f99059fF775485246999027B3197955';
    const messageOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected an error');
    };
    const rewritten = messageOf(() =>
      buildTarget('https://h/build', '/api/../v1', { userWalletAddress: wallet }),
    );
    expect(rewritten).toContain('rewritten on the wire');
    expect(rewritten).toContain('userWalletAddress=0x55d3…7955');
    const relative = messageOf(() => buildTarget('https://h/build', `api/v1/${wallet}`));
    expect(relative).toContain('must start with');
    for (const message of [rewritten, relative]) expect(message).not.toContain(wallet);
  });

  it('fills and encodes path parameters', () => {
    expect(fillPathParams('/api/v1/dex/aggregator/order/{orderId}', { orderId: 'a/b c' })).toBe(
      '/api/v1/dex/aggregator/order/a%2Fb%20c',
    );
    expect(() => fillPathParams('/order/{orderId}')).toThrow('missing path parameter');
  });
});

describe('increasingTimestamps', () => {
  it('never repeats a millisecond, and follows the clock when it moves ahead', () => {
    let now = 1_000;
    const next = increasingTimestamps(() => now);
    expect([next(), next(), next()]).toEqual([1_000, 1_001, 1_002]);
    now = 5_000.9;
    expect(next()).toBe(5_000);
    now = 4_000; // the clock steps back (NTP): still strictly increasing
    expect([next(), next()]).toEqual([5_001, 5_002]);
  });
});

describe('authHeaders', () => {
  const base = {
    apiKey: 'k',
    apiSecret: 's',
    timestamp: formatTimestamp(Date.parse('2026-05-11T10:08:57.715Z')),
    method: 'GET',
    requestPath: '/build/api/v1/x',
    body: '',
  };

  it('uses the documented header names and ISO-8601 millisecond timestamps', () => {
    const headers = authHeaders(base);
    expect(headers).toEqual({
      'X-OC-APIKEY': 'k',
      'X-OC-TIMESTAMP': '2026-05-11T10:08:57.715Z',
      'X-OC-SIGN': signPreHash('s', preHash(base)),
    });
  });

  it('sends the optional window and nonce under their documented names', () => {
    const headers = authHeaders({ ...base, recvWindowMs: 10_000, nonce: 'n-1' });
    expect(headers['X-OC-RECV-WINDOW']).toBe('10000');
    expect(headers['X-OC-NONCE']).toBe('n-1');
  });

  it('enforces the 60 s maximum receive window', () => {
    expect(() => authHeaders({ ...base, recvWindowMs: MAX_RECV_WINDOW_MS + 1 })).toThrow(
      '<= 60000',
    );
    expect(() => authHeaders({ ...base, recvWindowMs: 0 })).toThrow('positive integer');
  });
});
