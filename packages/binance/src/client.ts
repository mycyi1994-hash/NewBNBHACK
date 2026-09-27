/**
 * Binance Web3 API client — one entry point, `request(module, endpoint, options)` (SPEC §3.1).
 * We sign ourselves instead of wrapping @binance-web3/wallet because we need the raw envelope and
 * bytes for api_calls and fixtures, and because the connector cannot send some documented calls
 * (docs/vendor/ENDPOINTS.md, "Doc ↔ connector anomalies").
 */
import {
  BinanceApiError,
  isRateLimited,
  type BinanceApiErrorInit,
  type ErrorKind,
} from './errors.js';
import { parseEnvelope, type EnvelopeResult } from './envelope.js';
import type { FixtureRecorder } from './fixtures.js';
import { stringifyJsonLossless } from './json.js';
import { envelopeFlavour, rateLimitGroup, type ApiModule } from './modules.js';
import {
  MAX_RETRY_AFTER_MS,
  RateLimiter,
  retryAfterMs,
  systemClock,
  type Clock,
} from './rate-limit.js';
import {
  authHeaders,
  buildTarget,
  fillPathParams,
  formatTimestamp,
  increasingTimestamps,
  type Query,
} from './sign.js';
import { isTransient } from './taxonomy.js';
import { maskSensitive, requestIdOf, type ApiCallRecord, type ApiCallSink } from './telemetry.js';

/** Default wait for each telemetry hook (api_calls sink, fixture recorder). */
const TELEMETRY_TIMEOUT_MS = 5_000;

/** Backoff before retry `attempt` (0-based) of a transient failure: 0.5 s, 1 s, 2 s, … ≤ 8 s. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt);
}

export interface BinanceClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
  /** api_calls.region (REGION_TAG). */
  region?: string | null | undefined;
  fetch?: typeof fetch;
  clock?: Clock;
  limiter?: RateLimiter;
  /** api_calls hook; called once per HTTP attempt. */
  onApiCall?: ApiCallSink;
  /**
   * Called when a telemetry hook — the api_calls sink or the fixture recorder — throws or takes
   * longer than `telemetryTimeoutMs`; telemetry must never break a request.
   */
  onSinkError?: (error: unknown) => void;
  /** How long (ms) the request waits for each telemetry hook. Default 5 s. */
  telemetryTimeoutMs?: number;
  /** When set, every response can be saved; see `recordFixture`. */
  fixtures?: FixtureRecorder;
  /** Record every response (true) or only requests that ask for it (false, default). */
  recordAllFixtures?: boolean;
  recvWindowMs?: number;
  timeoutMs?: number;
  /** Server clock vs local clock beyond this (ms) triggers onClockSkew. */
  clockSkewWarnMs?: number;
  onClockSkew?: (skewMs: number, endpoint: string) => void;
  /** Extra values to keep out of api_calls.msg and fixtures (e.g. the house wallet address). */
  redact?: readonly string[];
}

export interface RequestOptions {
  method: 'GET' | 'POST';
  /** API path without the base path, e.g. `/api/v1/dex/market/rwa/tokens`; may contain `{param}`. */
  path: string;
  pathParams?: Readonly<Record<string, string>>;
  query?: Query;
  /** JSON body for POST; serialized once, and those exact bytes are signed and sent. */
  body?: unknown;
  /** Unsigned calls are only for reachability probes. Default true. */
  signed?: boolean;
  recordFixture?: boolean;
  /**
   * Extra attempts after a transient failure (SPEC §11: network, timeout, 5xx, 50000/50001, and
   * the module codes the taxonomy marks `retry`), with `retryBackoffMs` (or the server's
   * Retry-After) between them. Only for idempotent calls; default 0. A 429 is retried once after
   * Retry-After, independently (see `retryRateLimit`). A Retry-After above MAX_RETRY_AFTER_MS is
   * never waited out.
   */
  retries?: number;
  /**
   * Retry once after a rate-limit answer (HTTP 429 or code 42900), after Retry-After. Default
   * true. False sends the request at most once: the broadcast, whose outbox and api_calls
   * reasoning assume a single POST. The limiter pauses for Retry-After either way.
   */
  retryRateLimit?: boolean;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  usedWeight: number | null;
}

export interface ApiResponse<T> {
  data: T;
  code: number | string;
  msg: string | null;
  httpStatus: number;
  latencyMs: number;
  retryCount: number;
  serverTime: number | null;
  clockSkewMs: number | null;
  rateLimit: RateLimitInfo;
  requestId: string | null;
  fixturePath: string | null;
}

function headerInt(headers: Headers, name: string): number | null {
  const value = Number.parseInt(headers.get(name) ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * One line for a request that got no response. fetch() only says "fetch failed"; the reason —
 * ECONNREFUSED, ENOTFOUND, a TLS error, a socket closed mid-body — is in its `cause`.
 * Unmasked: the caller masks it for api_calls.msg.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (cause === undefined || cause === null) return error.message;
  const code =
    typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined;
  // Happy-eyeballs failures arrive as an AggregateError with an empty message.
  const text =
    cause instanceof AggregateError && cause.message === ''
      ? cause.errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')
      : cause instanceof Error
        ? cause.message
        : typeof cause === 'string'
          ? cause
          : '';
  const line = (text.split('\n')[0] ?? '').trim();
  const detail = code && !line.includes(code) ? (line ? `${code}: ${line}` : code) : line;
  return detail ? `${error.message} (${detail.slice(0, 300)})` : error.message;
}

/**
 * The message for a redirect we did not follow (fetch runs with `redirect: 'manual'`), or
 * undefined for any other response. The Location goes into api_calls.msg, masked by the caller.
 */
function refusedRedirect(response: Response): string | undefined {
  const redirect =
    response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
  if (!redirect) return undefined;
  const location = response.headers.get('location');
  const to = location ? ` to ${location.slice(0, 200)}` : '';
  return `redirect not followed (HTTP ${response.status}${to}): the API key and signature only go to the configured base URL`;
}

export class BinanceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly limiter: RateLimiter;
  private readonly secrets: string[];
  /** X-OC-TIMESTAMP source: never the same millisecond twice (see increasingTimestamps). */
  private readonly nextTimestamp: () => number;

  constructor(private readonly options: BinanceClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.limiter = options.limiter ?? new RateLimiter(undefined, this.clock);
    this.nextTimestamp = increasingTimestamps(() => this.clock.now());
    this.secrets = [options.apiKey, options.apiSecret, ...(options.redact ?? [])].filter(
      (v): v is string => typeof v === 'string' && v !== '',
    );
  }

  get hasCredentials(): boolean {
    return Boolean(this.options.apiKey && this.options.apiSecret);
  }

  async request<T = unknown>(
    module: ApiModule,
    endpoint: string,
    opts: RequestOptions,
  ): Promise<ApiResponse<T>> {
    const signed = opts.signed ?? true;
    const fail = (
      kind: ErrorKind,
      msg: string,
      extra: Partial<
        Pick<BinanceApiErrorInit, 'httpStatus' | 'code' | 'requestId' | 'retryAfterMs' | 'cause'>
      > = {},
    ) =>
      new BinanceApiError({
        kind,
        module,
        endpoint,
        httpStatus: extra.httpStatus ?? null,
        code: extra.code ?? null,
        msg,
        retryable: isTransient({
          kind,
          module,
          httpStatus: extra.httpStatus ?? null,
          code: extra.code ?? null,
        }),
        requestId: extra.requestId ?? null,
        ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
        ...(extra.cause === undefined ? {} : { cause: extra.cause }),
      });

    if (signed && !this.hasCredentials) throw fail('config', 'no API key/secret configured');
    if (opts.method === 'GET' && opts.body !== undefined) {
      throw fail('config', 'GET requests carry no body (the signature uses "")');
    }
    const target = buildTarget(
      this.options.baseUrl,
      fillPathParams(opts.path, opts.pathParams),
      opts.query,
    );
    const bodyText = opts.body === undefined ? '' : stringifyJsonLossless(opts.body);
    const group = rateLimitGroup(module);
    const retries = opts.retries ?? 0;

    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire(`${opts.method} ${opts.path}`, group);
      const timestamp = formatTimestamp(this.nextTimestamp());
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (bodyText !== '') headers['Content-Type'] = 'application/json';
      if (signed) {
        Object.assign(
          headers,
          authHeaders({
            apiKey: this.options.apiKey ?? '',
            apiSecret: this.options.apiSecret ?? '',
            timestamp,
            method: opts.method,
            requestPath: target.requestPath,
            body: bodyText,
            ...(this.options.recvWindowMs === undefined
              ? {}
              : { recvWindowMs: this.options.recvWindowMs }),
          }),
        );
      }

      const started = this.clock.now();
      let response: Response;
      let responseText: string;
      try {
        response = await this.fetchImpl(target.url, {
          method: opts.method,
          headers,
          ...(bodyText === '' ? {} : { body: bodyText }),
          // Following would resend X-OC-APIKEY and X-OC-SIGN to wherever the Location points
          // and hand us that server's answer; a 3xx is reported as an HTTP error instead.
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        });
        responseText = await response.text();
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        const kind: ErrorKind = timedOut ? 'timeout' : 'network';
        const msg = maskSensitive(describeFailure(error), this.secrets);
        await this.record({
          ts: timestamp,
          module,
          endpoint,
          method: opts.method,
          httpStatus: null,
          code: null,
          msg,
          latencyMs: this.clock.now() - started,
          requestId: null,
          retryCount: attempt,
          fixturePath: null,
        });
        if (attempt < retries) {
          await this.clock.sleep(retryBackoffMs(attempt));
          continue;
        }
        throw fail(kind, msg, { cause: error });
      }
      const latencyMs = this.clock.now() - started;
      const redirect = refusedRedirect(response);
      const envelope: EnvelopeResult =
        redirect === undefined
          ? parseEnvelope(response.status, responseText, envelopeFlavour(module), response.headers)
          : { ok: false, kind: 'http', code: null, msg: redirect, serverTime: null, body: null };
      const requestId = requestIdOf(response.headers);

      // The server has answered (for a broadcast: the transaction may be on its way), so from here
      // on a telemetry failure is reported to onSinkError and never becomes the request's error.
      // The fixture goes first so the api_calls row can point at it; a recorder that fails or
      // stalls costs at most telemetryTimeoutMs, and the row is written either way.
      let fixturePath: string | null = null;
      const recorder = this.options.fixtures;
      if (recorder && (opts.recordFixture || this.options.recordAllFixtures)) {
        const saved = await this.telemetry('fixture recorder', () =>
          recorder({
            module,
            endpoint,
            recordedAt: new Date(started),
            redact: this.secrets,
            request: { method: opts.method, requestPath: target.requestPath, body: bodyText },
            response: {
              httpStatus: response.status,
              headers: response.headers,
              bodyText: responseText,
            },
          }),
        );
        fixturePath = saved ?? null;
      }

      await this.record({
        ts: timestamp,
        module,
        endpoint,
        method: opts.method,
        httpStatus: response.status,
        code: envelope.code === null ? null : String(envelope.code),
        msg: envelope.msg === null ? null : maskSensitive(envelope.msg, this.secrets),
        latencyMs,
        requestId,
        retryCount: attempt,
        fixturePath,
      });

      const clockSkewMs =
        envelope.serverTime === null ? null : envelope.serverTime - (started + latencyMs / 2);
      if (clockSkewMs !== null && Math.abs(clockSkewMs) > (this.options.clockSkewWarnMs ?? 1_000)) {
        this.options.onClockSkew?.(clockSkewMs, endpoint);
      }

      if (envelope.ok) {
        return {
          data: envelope.data as T,
          code: envelope.code,
          msg: envelope.msg,
          httpStatus: response.status,
          latencyMs,
          retryCount: attempt,
          serverTime: envelope.serverTime,
          clockSkewMs,
          rateLimit: {
            limit: headerInt(response.headers, 'x-oc-ratelimit-limit'),
            remaining: headerInt(response.headers, 'x-oc-ratelimit-remaining'),
            usedWeight: headerInt(response.headers, 'x-oc-used-weight'),
          },
          requestId,
          fixturePath,
        };
      }

      const waitMs = retryAfterMs(response.headers.get('retry-after'), this.clock.now());
      const error = fail(envelope.kind, maskSensitive(envelope.msg, this.secrets), {
        httpStatus: response.status,
        code: envelope.code,
        requestId,
        ...(waitMs === undefined ? {} : { retryAfterMs: waitMs }),
      });
      // A Retry-After past MAX_RETRY_AFTER_MS is not slept here: the caller gets the retryable
      // error with the full retryAfterMs (the limiter pause is clamped as well).
      const waitsTooLong = waitMs !== undefined && waitMs > MAX_RETRY_AFTER_MS;
      if (isRateLimited(response.status, envelope.code)) {
        this.limiter.pause(waitMs ?? 1_000);
        // SPEC §11: on 429, honour Retry-After and retry once with a fresh timestamp/signature.
        if (attempt === 0 && (opts.retryRateLimit ?? true) && !waitsTooLong) continue;
        throw error;
      }
      if (error.retryable && attempt < retries && !waitsTooLong) {
        await this.clock.sleep(waitMs ?? retryBackoffMs(attempt));
        continue;
      }
      throw error;
    }
  }

  private async record(record: Omit<ApiCallRecord, 'region'>): Promise<void> {
    const sink = this.options.onApiCall;
    if (!sink) return;
    await this.telemetry('api_calls sink', () =>
      sink({ ...record, region: this.options.region ?? null }),
    );
  }

  /**
   * Runs a telemetry hook for at most telemetryTimeoutMs (real time, like the fetch timeout).
   * A throw, a rejection or a stall goes to onSinkError and yields undefined; a stalled hook keeps
   * running in the background, and its late rejection is already handled by the race.
   */
  private async telemetry<T>(hook: string, run: () => T | Promise<T>): Promise<T | undefined> {
    const ms = this.options.telemetryTimeoutMs ?? TELEMETRY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${hook} did not finish within ${ms} ms`)), ms);
    });
    try {
      return await Promise.race([Promise.resolve().then(run), stalled]);
    } catch (error) {
      (this.options.onSinkError ?? ((e) => console.warn(`${hook} failed:`, e)))(error);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
