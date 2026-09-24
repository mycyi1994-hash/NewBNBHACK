/**
 * Client-side limits so we never trip the gateway (llms-full.txt § Authentication › Rate Limits):
 * per endpoint 5 RPS, per API key / per IP 1,200 per 60 s (= 20/s), DeFi group 5 QPS shared.
 * Endpoint and group limits are sliding windows; the global limit is a token bucket. Either way a
 * caller reserves its slot immediately and waits until it would
 * be allowed, so concurrent callers queue fairly without a lock.
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

export interface WindowSpec {
  /** Requests allowed in any window. */
  max: number;
  windowMs: number;
  /** Extra spacing that absorbs clock and network jitter between us and the gateway. */
  marginMs: number;
}

/**
 * At most `max` sends in any `windowMs + marginMs` (a sliding log). The gateway counts
 * per-endpoint RPS this way: a 5/5 token bucket let a 6th quote through 422 ms after the 5th had
 * drained it, and the gateway answered 429 (dx/LOG.md 2026-09-24 01:50). The margin covers the
 * gateway counting arrival time, which trails our send time by a variable part of the latency.
 */
export class SlidingWindow {
  private readonly sends: number[] = [];

  constructor(readonly spec: WindowSpec) {
    if (spec.max <= 0 || spec.windowMs <= 0 || spec.marginMs < 0) {
      throw new Error('window spec must be positive');
    }
  }

  private get span(): number {
    return this.spec.windowMs + this.spec.marginMs;
  }

  /** Earliest time at or after `now` when one more send stays within the limit. */
  earliest(now: number): number {
    while (this.sends.length > 0 && (this.sends[0] ?? 0) <= now - this.span) this.sends.shift();
    const blocker =
      this.sends.length >= this.spec.max
        ? this.sends[this.sends.length - this.spec.max]
        : undefined;
    return blocker === undefined ? now : Math.max(now, blocker + this.span);
  }

  /** Records a send at `at` (≥ earliest). Callers may commit future times; order is kept. */
  commit(at: number): void {
    this.sends.push(at);
    this.sends.sort((a, b) => a - b);
  }
}

export interface RateLimiterSpec {
  perEndpoint: WindowSpec;
  global: BucketSpec;
  groups: Readonly<Record<string, WindowSpec>>;
}

export const DEFAULT_LIMITS: RateLimiterSpec = {
  perEndpoint: { max: 5, windowMs: 1000, marginMs: 250 },
  global: { capacity: 20, perSecond: 20 },
  groups: { defi: { max: 5, windowMs: 1000, marginMs: 250 } },
};

export class RateLimiter {
  private readonly endpoints = new Map<string, SlidingWindow>();
  private readonly groups = new Map<string, SlidingWindow>();
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
    const windows = [this.window(this.endpoints, endpointKey, this.spec.perEndpoint)];
    if (group) {
      const groupSpec = this.spec.groups[group];
      if (!groupSpec) throw new Error(`unknown rate-limit group "${group}"`);
      windows.push(this.window(this.groups, group, groupSpec));
    }
    const now = this.clock.now();
    const paused = Math.max(0, this.pausedUntil - now);
    const windowWait = Math.max(...windows.map((w) => w.earliest(now) - now));
    const wait = Math.max(paused, windowWait, this.global.reserve());
    // Record the time the request actually goes out: a 429 pause can push it past the slot.
    for (const w of windows) w.commit(now + wait);
    if (wait > 0) await this.clock.sleep(wait);
    return wait;
  }

  /** After a 429 the gateway does not say which dimension tripped, so everything waits. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }

  private window(map: Map<string, SlidingWindow>, key: string, spec: WindowSpec): SlidingWindow {
    let window = map.get(key);
    if (!window) {
      window = new SlidingWindow(spec);
      map.set(key, window);
    }
    return window;
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
