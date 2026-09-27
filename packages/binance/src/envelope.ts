/**
 * Response envelope parsing (docs/vendor/ENDPOINTS.md §2, docs/DECISIONS.md V-05):
 * - OCResult<T> `{code, msg, data, timestamp, success}`: `code === 0` is success. Market,
 *   Trading, Transaction and Wallet return business errors with HTTP 200, so the HTTP status
 *   alone never means success.
 * - B402 `{status, type, code: "000000000", errorData, data, subData, params}`.
 * - Gateway errors carry an OC-style numeric code with a 4xx/5xx status (and no `success`).
 * Anything that is not a JSON envelope (WAF challenge, HTML, empty body) is a transport error.
 */
import { parseJsonLossless } from './json.js';
import type { EnvelopeFlavour } from './modules.js';

export const B402_SUCCESS_CODE = '000000000';

export type EnvelopeResult =
  | {
      ok: true;
      data: unknown;
      code: number | string;
      msg: string | null;
      serverTime: number | null;
      body: unknown;
    }
  | {
      ok: false;
      kind: 'api' | 'http' | 'transport';
      code: number | string | null;
      msg: string;
      serverTime: number | null;
      body: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value) && value.length < 16) return Number(value);
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function serverTimeOf(body: Record<string, unknown>): number | null {
  const t = body.timestamp;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'bigint') return Number(t);
  return null;
}

export function parseEnvelope(
  httpStatus: number,
  bodyText: string,
  flavour: EnvelopeFlavour,
  headers?: Headers,
): EnvelopeResult {
  const http2xx = httpStatus >= 200 && httpStatus < 300;
  let body: unknown;
  try {
    body = bodyText.trim() === '' ? undefined : parseJsonLossless(bodyText);
  } catch {
    body = undefined;
  }

  if (!isRecord(body)) {
    const waf = headers?.get('x-amzn-waf-action');
    const described =
      bodyText.trim() === '' ? 'empty body' : `non-JSON body (${bodyText.length} chars)`;
    return {
      ok: false,
      kind: http2xx ? 'transport' : 'http',
      code: null,
      msg: `${described}${waf ? `, x-amzn-waf-action: ${waf}` : ''}`,
      serverTime: null,
      body: bodyText.slice(0, 500),
    };
  }

  const serverTime = serverTimeOf(body);
  const oc = numericCode(body.code);

  // B402 envelopes carry string codes ("000000000" success, "1160401" …); gateway errors on
  // B402 paths are OC-style with a numeric code and fall through to the OC rules below.
  if (flavour === 'b402' && typeof body.code === 'string') {
    const ok = body.code === B402_SUCCESS_CODE && http2xx;
    const msg = text(body.errorData) ?? text(body.status) ?? text(body.type);
    return ok
      ? { ok, data: body.data, code: body.code, msg, serverTime, body }
      : {
          ok,
          kind: 'api',
          code: body.code,
          msg: msg ?? `b402 envelope code ${body.code}`,
          serverTime,
          body,
        };
  }

  if (oc === null) {
    return {
      ok: false,
      kind: http2xx ? 'transport' : 'http',
      code: null,
      msg: `response has no envelope code (HTTP ${httpStatus})`,
      serverTime,
      body,
    };
  }

  const msg = text(body.msg);
  if (oc === 0 && body.success !== false && http2xx) {
    return { ok: true, data: body.data, code: oc, msg, serverTime, body };
  }
  return {
    ok: false,
    kind: 'api',
    code: oc,
    msg: msg ?? (oc === 0 ? `HTTP ${httpStatus} with code 0` : `code ${oc}`),
    serverTime,
    body,
  };
}
