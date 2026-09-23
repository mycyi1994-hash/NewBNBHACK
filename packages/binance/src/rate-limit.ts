/**
 * Client-side limits so we never trip the gateway (llms-full.txt § Authentication › Rate Limits):
 * per endpoint 5 RPS, per API key / per IP 1,200 per 60 s (= 20/s), DeFi group 5 QPS shared.
 * Each bucket may go negative: a caller reserves a token immediately and waits until it would
 * have been available, so concurrent callers queue fairly without a lock.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface BucketSpec {
  /** Burst size. */
  capacity: number;
  /** Sustained tokens per second. */
  perSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    readonly spec: BucketSpec,
    private readonly clock: Pick<Clock, 'now'>,
  ) {
    if (spec.capacity <= 0 || spec.perSecond <= 0) throw new Error('bucket spec must be positive');
    this.tokens = spec.capacity;
    this.updatedAt = clock.now();
  }

  /** Takes one token and returns how long the caller must wait before using it (ms). */
  reserve(): number {
    const now = this.clock.now();
    const refilled = ((now - this.updatedAt) / 1000) * this.spec.perSecond;
    this.tokens = Math.min(this.spec.capacity, this.tokens + refilled);
    this.updatedAt = now;
    this.tokens -= 1;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.spec.perSecond) * 1000);
  }
}

export interface RateLimiterSpec {
  perEndpoint: BucketSpec;
  global: BucketSpec;
  groups: Readonly<Record<string, BucketSpec>>;
}

export const DEFAULT_LIMITS: RateLimiterSpec = {
  perEndpoint: { capacity: 5, perSecond: 5 },
  global: { capacity: 20, perSecond: 20 },
  groups: { defi: { capacity: 5, perSecond: 5 } },
};

export class RateLimiter {
  private readonly endpoints = new Map<string, TokenBucket>();
  private readonly groups = new Map<string, TokenBucket>();
  private readonly global: TokenBucket;
  private pausedUntil = 0;

  constructor(
    private readonly spec: RateLimiterSpec = DEFAULT_LIMITS,
    private readonly clock: Clock = systemClock,
  ) {
    this.global = new TokenBucket(spec.global, clock);
  }

  /** Waits for a slot on the endpoint, its group (if any) and the global bucket. */
  async acquire(endpointKey: string, group?: string): Promise<number> {
    const buckets = [this.global, this.bucket(this.endpoints, endpointKey, this.spec.perEndpoint)];
    if (group) {
      const groupSpec = this.spec.groups[group];
      if (!groupSpec) throw new Error(`unknown rate-limit group "${group}"`);
      buckets.push(this.bucket(this.groups, group, groupSpec));
    }
    const paused = Math.max(0, this.pausedUntil - this.clock.now());
    const wait = Math.max(paused, ...buckets.map((b) => b.reserve()));
    if (wait > 0) await this.clock.sleep(wait);
    return wait;
  }

  /** After a 429 the gateway does not say which dimension tripped, so everything waits. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }

  private bucket(map: Map<string, TokenBucket>, key: string, spec: BucketSpec): TokenBucket {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = new TokenBucket(spec, this.clock);
      map.set(key, bucket);
    }
    return bucket;
  }
}

/** `Retry-After` is in seconds (llms-full.txt § Authentication › Rate Limits); HTTP dates too. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
