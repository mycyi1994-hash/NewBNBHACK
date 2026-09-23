import { describe, expect, it } from 'vitest';
import { RateLimiter, TokenBucket, retryAfterMs, type Clock } from './rate-limit.js';

function fakeClock(start = 0): Clock & { advance(ms: number): void; slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    advance: (ms) => {
      now += ms;
    },
    slept,
  };
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then spaces calls at the sustained rate', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 5, perSecond: 5 }, clock);
    expect([1, 2, 3, 4, 5].map(() => bucket.reserve())).toEqual([0, 0, 0, 0, 0]);
    expect(bucket.reserve()).toBe(200);
    expect(bucket.reserve()).toBe(400);
  });

  it('refills over time but never above capacity', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 2, perSecond: 1 }, clock);
    bucket.reserve();
    bucket.reserve();
    clock.advance(10_000);
    expect([bucket.reserve(), bucket.reserve(), bucket.reserve()]).toEqual([0, 0, 1000]);
  });
});

describe('RateLimiter', () => {
  it('keeps each endpoint at 5 requests per second', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(undefined, clock);
    for (let i = 0; i < 5; i++) expect(await limiter.acquire('GET /a')).toBe(0);
    expect(await limiter.acquire('GET /a')).toBe(200);
    expect(await limiter.acquire('GET /b')).toBe(0);
  });

  it('holds the global budget at 20 per second (1,200 per minute)', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(undefined, clock);
    const waits: number[] = [];
    for (let i = 0; i < 21; i++) waits.push(await limiter.acquire(`GET /e${i}`));
    expect(waits.slice(0, 20).every((w) => w === 0)).toBe(true);
    expect(waits[20]).toBe(50);
  });

  it('makes DeFi endpoints share one 5 QPS budget', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(undefined, clock);
    for (let i = 0; i < 5; i++) expect(await limiter.acquire(`POST /defi/${i}`, 'defi')).toBe(0);
    expect(await limiter.acquire('POST /defi/other', 'defi')).toBe(200);
  });

  it('pauses everything after a 429 for the Retry-After period', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(undefined, clock);
    limiter.pause(3_000);
    expect(await limiter.acquire('GET /x')).toBe(3_000);
  });

  it('rejects unknown groups', async () => {
    await expect(new RateLimiter(undefined, fakeClock()).acquire('GET /x', 'nope')).rejects.toThrow(
      'unknown rate-limit group',
    );
  });
});

describe('retryAfterMs', () => {
  it('reads seconds (llms-full.txt § Authentication › Rate Limits)', () => {
    expect(retryAfterMs('2', 0)).toBe(2_000);
    expect(retryAfterMs('0.5', 0)).toBe(500);
  });

  it('reads HTTP dates and ignores garbage', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    expect(retryAfterMs('Wed, 23 Sep 2026 00:00:05 GMT', now)).toBe(5_000);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });
});
