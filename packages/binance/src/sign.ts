/**
 * Request signing, per llms-full.txt § Authentication (docs/DECISIONS.md V-01…V-04):
 *   preHash   = timestamp + METHOD + requestPath + body
 *   X-OC-SIGN = Base64(HMAC-SHA256(preHash, secretKey))
 * requestPath carries the `/build` base-path prefix and the raw query exactly as sent; body is ""
 * for GET. The signature test compares this module with the official connector byte for byte.
 */
import { createHmac } from 'node:crypto';

export type QueryValue = string | number | boolean | bigint;
export type Query = Readonly<Record<string, QueryValue | null | undefined>>;

export const MAX_RECV_WINDOW_MS = 60_000;

/**
 * Percent-encodes everything except RFC 3986 unreserved characters. The output is a fixed point
 * of WHATWG URL parsing, so the string we sign is exactly the string fetch() sends.
 * (encodeURIComponent alone leaves `'`, which `new URL()` rewrites to `%27` on the wire.)
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Query string in insertion order; null/undefined values are dropped. */
export function encodeQuery(query: Query = {}): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeRfc3986(key)}=${encodeRfc3986(String(value))}`);
  }
  return parts.join('&');
}

/** Replaces `{name}` segments with encoded values; every placeholder must be supplied. */
export function fillPathParams(
  pathTemplate: string,
  params: Readonly<Record<string, string>> = {},
) {
  return pathTemplate.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined)
      throw new Error(`missing path parameter "${name}" for ${pathTemplate}`);
    return encodeRfc3986(value);
  });
}

export interface WireTarget {
  /** Absolute URL passed to fetch(). */
  url: string;
  /** Path + query as it appears on the HTTP request line; this is what gets signed. */
  requestPath: string;
}

/**
 * Joins the base URL's path (e.g. `/build`) with an API path and query, and proves that URL
 * parsing leaves the result untouched — otherwise the signature would not match the wire.
 */
export function buildTarget(baseUrl: string, apiPath: string, query?: Query): WireTarget {
  if (!apiPath.startsWith('/')) throw new Error(`API path must start with "/": ${apiPath}`);
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const search = encodeQuery(query);
  const requestPath = `${basePath}${apiPath}${search ? `?${search}` : ''}`;
  const url = `${base.origin}${requestPath}`;
  const parsed = new URL(url);
  if (`${parsed.pathname}${parsed.search}` !== requestPath) {
    throw new Error(`request path would be rewritten on the wire: ${requestPath}`);
  }
  return { url, requestPath };
}

export interface PreHashParts {
  timestamp: string;
  method: string;
  requestPath: string;
  body: string;
}

export function preHash({ timestamp, method, requestPath, body }: PreHashParts): string {
  return `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
}

export function signPreHash(secretKey: string, preHashString: string): string {
  return createHmac('sha256', secretKey).update(preHashString, 'utf8').digest('base64');
}

/** `X-OC-TIMESTAMP` format: UTC ISO 8601 with milliseconds, e.g. 2026-05-11T10:08:57.715Z. */
export function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export interface AuthInput extends PreHashParts {
  apiKey: string;
  apiSecret: string;
  recvWindowMs?: number;
  nonce?: string;
}

export function authHeaders(input: AuthInput): Record<string, string> {
  const headers: Record<string, string> = {
    'X-OC-APIKEY': input.apiKey,
    'X-OC-TIMESTAMP': input.timestamp,
    'X-OC-SIGN': signPreHash(input.apiSecret, preHash(input)),
  };
  if (input.recvWindowMs !== undefined) {
    if (!Number.isInteger(input.recvWindowMs) || input.recvWindowMs <= 0) {
      throw new Error('recvWindowMs must be a positive integer');
    }
    if (input.recvWindowMs > MAX_RECV_WINDOW_MS) {
      throw new Error(
        `recvWindowMs must be <= ${MAX_RECV_WINDOW_MS} (llms-full.txt § Authentication)`,
      );
    }
    headers['X-OC-RECV-WINDOW'] = String(input.recvWindowMs);
  }
  if (input.nonce !== undefined) headers['X-OC-NONCE'] = input.nonce;
  return headers;
}
