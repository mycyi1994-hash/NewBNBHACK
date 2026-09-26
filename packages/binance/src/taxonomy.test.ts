/**
 * Error taxonomy v1 (SPEC §11, M1-07): one assertion per code, and a check that the code map
 * matches the official error tables when the docs snapshot is present (docs/vendor, not committed).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiModule } from './modules.js';
import type { ApiCallRecord } from './telemetry.js';
import {
  classifyError,
  documentedCodes,
  dxFindingOf,
  isTransient,
  moduleCodes,
  venueMinimumUsd,
  type ErrorClass,
} from './taxonomy.js';

const api = (module: ApiModule, code: number, httpStatus = 200) =>
  classifyError({ kind: 'api', module, httpStatus, code });

type Expect = Pick<ErrorClass, 'action' | 'alert' | 'userKey'>;

/** SPEC §11 table, row by row (module, code) → handling. */
const SPEC_11: [ApiModule, number, Expect][] = [
  ['trading', 40001, { action: 'fail', alert: true, userKey: 'err.internal' }],
  ['rwa', 40101, { action: 'fail', alert: true, userKey: 'err.internal' }],
  ['rwa', 40102, { action: 'fail', alert: true, userKey: 'err.internal' }],
  ['rwa', 40103, { action: 'fail', alert: true, userKey: 'err.internal' }],
  ['rwa', 40104, { action: 'fail', alert: true, userKey: 'err.internal' }],
  ['rwa', 40301, { action: 'fail', alert: true, userKey: 'err.region' }],
  ['trading', 40302, { action: 'fail', alert: true, userKey: 'err.region' }],
  ['trading', 40303, { action: 'fail', alert: true, userKey: 'err.region' }],
  ['defi-transaction', 40304, { action: 'fail', alert: true, userKey: 'err.region' }],
  [
    'trading',
    40369,
    { action: 'market_closed', alert: false, userKey: 'why.deferred.market_closed' },
  ],
  [
    'trading',
    40367,
    { action: 'market_closed', alert: false, userKey: 'why.deferred.market_closed' },
  ],
  ['trading', 40374, { action: 'next_issuer', alert: false, userKey: 'why.skipped.no_liquidity' }],
  ['trading', 40375, { action: 'next_issuer', alert: false, userKey: 'why.skipped.below_min' }],
  ['trading', 40365, { action: 'next_issuer', alert: false, userKey: 'why.skipped.no_liquidity' }],
  ['trading', 40366, { action: 'next_issuer', alert: false, userKey: 'why.skipped.no_liquidity' }],
  ['trading', 40368, { action: 'fail', alert: true, userKey: 'err.internal' }],
  ['trading', 40370, { action: 'fail', alert: true, userKey: 'err.internal' }],
  ['trading', 40401, { action: 'requote', alert: false, userKey: null }],
  ['trading', 40421, { action: 'next_issuer', alert: false, userKey: 'why.skipped.no_liquidity' }],
  ['trading', 40441, { action: 'defer', alert: false, userKey: 'why.skipped.no_liquidity' }],
  ['trading', 40461, { action: 'requote', alert: false, userKey: null }],
  ['trading', 40463, { action: 'reduce_size', alert: false, userKey: 'why.deferred.quote_impact' }],
  ['trading', 40465, { action: 'retry', alert: false, userKey: 'err.trade' }],
  ['trading', 40432, { action: 'retry', alert: false, userKey: 'err.internal' }],
  ['trading', 42900, { action: 'retry', alert: false, userKey: null }],
  ['trading', 50000, { action: 'retry', alert: false, userKey: 'err.internal' }],
  ['market', 50001, { action: 'retry', alert: false, userKey: 'err.internal' }],
  ['transaction', 40431, { action: 'rpc_fallback', alert: false, userKey: null }],
  ['transaction', 40434, { action: 'fail', alert: true, userKey: 'err.trade' }],
  ['defi-transaction', 40460, { action: 'fail', alert: false, userKey: 'why.failed.simulation' }],
  ['defi-transaction', 40482, { action: 'retry', alert: false, userKey: 'err.internal' }],
  ['defi-transaction', 40484, { action: 'fail', alert: false, userKey: 'why.failed.simulation' }],
  ['defi-transaction', 40485, { action: 'fail', alert: false, userKey: 'why.failed.simulation' }],
];

describe('classifyError — SPEC §11 by code', () => {
  it.each(SPEC_11)('%s %i', (module, code, expected) => {
    expect(api(module, code)).toMatchObject({ ...expected, code: String(code), documented: true });
  });

  it('reads string codes the same as numbers (api_calls stores text)', () => {
    expect(
      classifyError({ kind: 'api', module: 'trading', httpStatus: 200, code: '40401' }).action,
    ).toBe('requote');
  });

  it('gives a code the meaning of its own module', () => {
    // 40470 is a Solana fee error in Trading but "resource not found" in DeFi data.
    expect(api('trading', 40470).meaning).toMatch(/Solana/);
    expect(api('defi-data', 40470).meaning).toMatch(/not found/);
    // A module code does not leak into another module.
    expect(api('market', 40401)).toMatchObject({ documented: false, action: 'fail', alert: true });
  });
});

describe('classifyError — failures without a documented code', () => {
  it('retries network failures and timeouts', () => {
    for (const kind of ['network', 'timeout'] as const) {
      expect(
        classifyError({ kind, module: 'trading', httpStatus: null, code: null }),
      ).toMatchObject({
        category: 'network',
        action: 'retry',
        alert: false,
        documented: true,
      });
    }
  });

  it('retries a 429 and a 5xx without an envelope', () => {
    expect(classifyError({ kind: 'http', module: 'rwa', httpStatus: 429, code: null }).action).toBe(
      'retry',
    );
    expect(
      classifyError({ kind: 'http', module: 'rwa', httpStatus: 502, code: null }),
    ).toMatchObject({
      action: 'retry',
      documented: true,
    });
  });

  it('treats a missing credential as our bug', () => {
    expect(
      classifyError({ kind: 'config', module: 'rwa', httpStatus: null, code: null }),
    ).toMatchObject({
      action: 'fail',
      alert: true,
      userKey: 'err.internal',
    });
  });

  it('reports a response that is not an envelope as undocumented, and defers', () => {
    expect(
      classifyError({ kind: 'transport', module: 'rwa', httpStatus: 200, code: null }),
    ).toMatchObject({
      category: 'unknown',
      action: 'defer',
      alert: true,
      documented: false,
    });
    expect(
      classifyError({ kind: 'http', module: 'rwa', httpStatus: 403, code: null }),
    ).toMatchObject({
      documented: false,
      meaning: 'HTTP 403 without an envelope code',
    });
  });

  it('fails safely on an unknown code and marks it for a DX event', () => {
    expect(api('trading', 40999)).toEqual({
      code: '40999',
      category: 'unknown',
      action: 'fail',
      alert: true,
      userKey: 'err.internal',
      documented: false,
      meaning: 'code 40999 is not in the trading error table',
    });
  });

  it('calls only retry actions transient', () => {
    expect(isTransient({ kind: 'api', module: 'trading', httpStatus: 200, code: 50000 })).toBe(
      true,
    );
    expect(isTransient({ kind: 'api', module: 'trading', httpStatus: 200, code: 40401 })).toBe(
      false,
    );
    expect(isTransient({ kind: 'api', module: 'trading', httpStatus: 200, code: 40375 })).toBe(
      false,
    );
  });
});

describe('dxFindingOf', () => {
  const record = (overrides: Partial<ApiCallRecord>): ApiCallRecord => ({
    ts: '2026-09-28T13:32:01.000Z',
    region: 'fra',
    module: 'trading',
    endpoint: 'getAggregatedQuote',
    method: 'GET',
    httpStatus: 200,
    code: '0',
    msg: 'success',
    latencyMs: 120,
    requestId: null,
    retryCount: 0,
    fixturePath: null,
    ...overrides,
  });

  it('ignores successes, documented codes, rate limits and calls with no response', () => {
    expect(dxFindingOf(record({}))).toBeUndefined();
    expect(
      dxFindingOf(record({ code: '40375', msg: 'Minimum order amount is 5 USD.' })),
    ).toBeUndefined();
    expect(dxFindingOf(record({ httpStatus: 429, code: '42900' }))).toBeUndefined();
    expect(
      dxFindingOf(record({ httpStatus: null, code: null, msg: 'fetch failed' })),
    ).toBeUndefined();
    expect(dxFindingOf(record({ httpStatus: 503, code: null }))).toBeUndefined();
  });

  it('reports a code the module table does not list', () => {
    expect(dxFindingOf(record({ code: '40999', msg: 'new' }))).toEqual({
      kind: 'unknown_code',
      meaning: 'code 40999 is not in the trading error table',
    });
  });

  it('reports an error response without the documented envelope', () => {
    expect(
      dxFindingOf(record({ httpStatus: 200, code: null, msg: 'non-JSON body (512 chars)' })),
    ).toMatchObject({ kind: 'undocumented_shape' });
    expect(dxFindingOf(record({ httpStatus: 403, code: null }))).toMatchObject({
      kind: 'undocumented_shape',
      meaning: 'HTTP 403 without an envelope code',
    });
  });
});

describe('venueMinimumUsd', () => {
  it('reads the minimum from the 40375 message', () => {
    expect(venueMinimumUsd('Minimum order amount is 5 USD.')).toBe('5');
    expect(venueMinimumUsd('Minimum order amount is 20 USD.')).toBe('20');
    expect(venueMinimumUsd('Minimum order amount is 5.5 USD')).toBe('5.5');
    expect(venueMinimumUsd('Insufficient liquidity')).toBeUndefined();
  });
});

const DOCS = path.join(import.meta.dirname, '..', '..', '..', 'docs', 'vendor', 'llms-full.txt');

/** Codes listed in the error table of one product page of the docs snapshot. */
function docCodes(product: string): string[] {
  const text = readFileSync(DOCS, 'utf8');
  const start = text.indexOf(`URL: /en/dev-docs/products/${product}/error-codes`);
  const end = text.indexOf('## Document:', start);
  const section = text.slice(start, end === -1 ? undefined : end);
  return [...new Set([...section.matchAll(/^\| `(\d{5})`/gm)].map((m) => m[1] ?? ''))].sort();
}

describe.skipIf(!existsSync(DOCS))('code map vs the official error tables (docs snapshot)', () => {
  const pages: [string, ApiModule][] = [
    ['trading-api', 'trading'],
    ['transaction-api', 'transaction'],
    ['defi-api', 'defi-transaction'],
    ['market-api', 'market'],
    ['wallet-api', 'wallet'],
  ];

  it.each(pages)('every code on %s is classified', (product, module) => {
    const listed = docCodes(product);
    expect(listed.length).toBeGreaterThan(5);
    expect(listed.filter((code) => !documentedCodes(module).includes(code))).toEqual([]);
  });

  it.each(pages)('every %s code we map is on that page', (product, module) => {
    const listed = docCodes(product);
    expect(moduleCodes(module).filter((code) => !listed.includes(code))).toEqual([]);
  });
});
