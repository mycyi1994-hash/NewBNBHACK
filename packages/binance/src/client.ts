/**
 * Binance Web3 API client — one entry point, `request(module, endpoint, options)` (SPEC §3.1).
 * We sign ourselves instead of wrapping @binance-web3/wallet because we need the raw envelope and
 * bytes for api_calls and fixtures, and because the connector cannot send some documented calls
 * (docs/vendor/ENDPOINTS.md, "Doc ↔ connector anomalies").
 */
import {
  BinanceApiError,
  isRateLimited,
  isRetryable,
  type BinanceApiErrorInit,
  type ErrorKind,
} from './errors.js';
import { parseEnvelope } from './envelope.js';
import type { FixtureRecorder } from './fixtures.js';
import { stringifyJsonLossless } from './json.js';
import { envelopeFlavour, rateLimitGroup, type ApiModule } from './modules.js';
import { RateLimiter, retryAfterMs, systemClock, type Clock } from './rate-limit.js';
import { authHeaders, buildTarget, fillPathParams, formatTimestamp, type Query } from './sign.js';
import { maskSensitive, requestIdOf, type ApiCallRecord, type ApiCallSink } from './telemetry.js';

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
  /** Called when the hook throws; telemetry must never break a request. */
  onSinkError?: (error: unknown) => void;
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

export class BinanceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly limiter: RateLimiter;
  private readonly secrets: string[];

  constructor(private readonly options: BinanceClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.limiter = options.limiter ?? new RateLimiter(undefined, this.clock);
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
        Pick<BinanceApiErrorInit, 'httpStatus' | 'code' | 'requestId' | 'retryAfterMs'>
      > = {},
    ) =>
      new BinanceApiError({
        kind,
        module,
        endpoint,
        httpStatus: extra.httpStatus ?? null,
        code: extra.code ?? null,
        msg,
        retryable: isRetryable(kind, extra.httpStatus ?? null, extra.code ?? null),
        requestId: extra.requestId ?? null,
        ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
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

    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire(`${opts.method} ${opts.path}`, group);
      const timestamp = formatTimestamp(this.clock.now());
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
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        });
        responseText = await response.text();
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        const kind: ErrorKind = timedOut ? 'timeout' : 'network';
        const msg = maskSensitive(
          error instanceof Error ? error.message : String(error),
          this.secrets,
        );
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
        throw fail(kind, msg);
      }
      const latencyMs = this.clock.now() - started;
      const envelope = parseEnvelope(
        response.status,
        responseText,
        envelopeFlavour(module),
        response.headers,
      );
      const requestId = requestIdOf(response.headers);

      let fixturePath: string | null = null;
      if (this.options.fixtures && (opts.recordFixture || this.options.recordAllFixtures)) {
        fixturePath = await this.options.fixtures({
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
        });
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
      if (isRateLimited(response.status, envelope.code)) {
        this.limiter.pause(waitMs ?? 1_000);
        // SPEC §11: on 429, honour Retry-After and retry once with a fresh timestamp/signature.
        if (attempt === 0) continue;
      }
      throw fail(envelope.kind, maskSensitive(envelope.msg, this.secrets), {
        httpStatus: response.status,
        code: envelope.code,
        requestId,
        ...(waitMs === undefined ? {} : { retryAfterMs: waitMs }),
      });
    }
  }

  private async record(record: Omit<ApiCallRecord, 'region'>): Promise<void> {
    if (!this.options.onApiCall) return;
    try {
      await this.options.onApiCall({ ...record, region: this.options.region ?? null });
    } catch (error) {
      (this.options.onSinkError ?? ((e) => console.warn('api_calls sink failed:', e)))(error);
    }
  }
}
