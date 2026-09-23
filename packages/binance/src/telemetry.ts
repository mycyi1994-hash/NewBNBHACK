import type { ApiModule } from './modules.js';

/**
 * One row of the api_calls table (SPEC §3.1 item 2), recorded for every HTTP attempt.
 * `ts` is the X-OC-TIMESTAMP we sent — the value Binance support asks for
 * (llms-full.txt § Support › Before You Reach Out).
 */
export interface ApiCallRecord {
  ts: string;
  region: string | null;
  module: ApiModule;
  endpoint: string;
  method: string;
  httpStatus: number | null;
  code: string | null;
  msg: string | null;
  latencyMs: number;
  requestId: string | null;
  retryCount: number;
  fixturePath: string | null;
}

export type ApiCallSink = (record: ApiCallRecord) => void | Promise<void>;

/**
 * The docs name no request-id response header; these are the ones commonly set by gateways and
 * CloudFront. Whichever is present is kept so a DX report can cite it.
 */
export const REQUEST_ID_HEADERS = [
  'x-request-id',
  'x-oc-request-id',
  'x-amzn-requestid',
  'x-amz-cf-id',
];

export function requestIdOf(headers: Headers): string | null {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/** Replaces each listed value (hex compared case-insensitively) with `[redacted]`. */
export function redactValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value.length < 4) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(escaped, /^0x[0-9a-fA-F]+$/.test(value) ? 'gi' : 'g'),
      '[redacted]',
    );
  }
  return out;
}

/**
 * For free text such as api_calls.msg: redacts known secrets and shortens every 20-byte address
 * to 0x1234…abcd (SPEC §14). Fixtures use redactValues only, so public token contract addresses
 * in recorded responses stay usable.
 */
export function maskSensitive(text: string, secrets: readonly string[] = []): string {
  return redactValues(text, secrets).replace(ADDRESS, (a) => `${a.slice(0, 6)}…${a.slice(-4)}`);
}
