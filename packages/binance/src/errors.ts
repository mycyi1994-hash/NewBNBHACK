import type { ApiModule } from './modules.js';

/**
 * - `api`: the server answered with an envelope whose code is not success (often HTTP 200).
 * - `http`: non-2xx without a usable envelope code.
 * - `transport`: a 2xx/other response that is not an envelope at all (HTML, WAF challenge, empty).
 * - `network` / `timeout`: no response.
 * - `config`: the request could not be built (e.g. no API key for a signed call).
 */
export type ErrorKind = 'api' | 'http' | 'transport' | 'network' | 'timeout' | 'config';

export interface BinanceApiErrorInit {
  kind: ErrorKind;
  module: ApiModule;
  endpoint: string;
  httpStatus: number | null;
  code: number | string | null;
  msg: string;
  retryable: boolean;
  requestId?: string | null;
  retryAfterMs?: number;
  cause?: unknown;
}

/** SPEC §3.1 item 3: every failure is normalized to this shape. Code mapping (§11) is M1-07. */
export class BinanceApiError extends Error {
  readonly kind: ErrorKind;
  readonly module: ApiModule;
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly code: number | string | null;
  readonly msg: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly retryAfterMs: number | undefined;

  constructor(init: BinanceApiErrorInit) {
    const status = init.httpStatus === null ? 'no response' : `HTTP ${init.httpStatus}`;
    super(`${init.module}/${init.endpoint}: ${status}, code ${init.code ?? '-'}: ${init.msg}`, {
      cause: init.cause,
    });
    this.name = 'BinanceApiError';
    this.kind = init.kind;
    this.module = init.module;
    this.endpoint = init.endpoint;
    this.httpStatus = init.httpStatus;
    this.code = init.code;
    this.msg = init.msg;
    this.retryable = init.retryable;
    this.requestId = init.requestId ?? null;
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** Gateway rate-limit body code (llms-full.txt § Authentication › Error Codes). */
export const RATE_LIMIT_CODE = 42900;
const SERVER_CODES = new Set([50000, 50001]);

export function isRateLimited(httpStatus: number | null, code: number | string | null): boolean {
  return httpStatus === 429 || code === RATE_LIMIT_CODE;
}

/** Transient by the docs' own wording: rate limits, 5xx, 50000/50001, and no-response failures. */
export function isRetryable(
  kind: ErrorKind,
  httpStatus: number | null,
  code: number | string | null,
): boolean {
  if (kind === 'network' || kind === 'timeout') return true;
  if (isRateLimited(httpStatus, code)) return true;
  if (httpStatus !== null && httpStatus >= 500) return true;
  return typeof code === 'number' && SERVER_CODES.has(code);
}
