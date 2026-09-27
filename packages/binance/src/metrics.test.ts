import { describe, expect, it } from 'vitest';
import { isSuccess, percentile, renderMetricsMarkdown, summarizeCalls } from './metrics.js';
import type { ApiCallRecord } from './telemetry.js';

// Unit-test input for the aggregation maths, not recorded API data.
function call(overrides: Partial<ApiCallRecord>): ApiCallRecord {
  return {
    ts: '2026-09-23T00:00:00.000Z',
    region: 'fra',
    module: 'rwa',
    endpoint: 'getRwaTokenList',
    method: 'GET',
    httpStatus: 200,
    code: '0',
    msg: 'success',
    latencyMs: 100,
    requestId: null,
    retryCount: 0,
    fixturePath: null,
    ...overrides,
  };
}

describe('percentile (nearest rank)', () => {
  it('matches the textbook definition', () => {
    const sorted = [15, 20, 35, 40, 50];
    expect(percentile(sorted, 50)).toBe(35);
    expect(percentile(sorted, 95)).toBe(50);
    expect(percentile(sorted, 0)).toBe(15);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('isSuccess', () => {
  it('needs a response, HTTP < 400 and the success envelope code', () => {
    expect(isSuccess(call({}))).toBe(true);
    expect(isSuccess(call({ module: 'b402', code: '000000000' }))).toBe(true);
    expect(isSuccess(call({ code: '40401' }))).toBe(false);
    expect(isSuccess(call({ httpStatus: 401, code: '40102' }))).toBe(false);
    expect(isSuccess(call({ httpStatus: null, code: null }))).toBe(false);
    expect(isSuccess(call({ httpStatus: 202, code: null }))).toBe(false);
  });
});

describe('renderMetricsMarkdown', () => {
  it('reports counts, error rates, latency percentiles, regions and error codes', () => {
    const records = [
      call({ latencyMs: 100 }),
      call({ latencyMs: 300, ts: '2026-09-23T00:01:00.000Z' }),
      call({
        latencyMs: 200,
        httpStatus: 200,
        code: '40001',
        msg: 'Parameter [x] error',
        ts: '2026-09-23T00:02:00.000Z',
      }),
      call({
        region: null,
        module: 'trading',
        endpoint: 'getAggregatedQuote',
        httpStatus: null,
        code: null,
        msg: 'fetch failed',
        latencyMs: 5_000,
      }),
    ];
    const md = renderMetricsMarkdown(records, {
      generatedAt: new Date('2026-09-27T00:00:00Z'),
      since: null,
    });
    expect(md).toContain('4 HTTP attempts');
    expect(md).toContain('| rwa | getRwaTokenList | 3 | 1 | 33.3% | 200 | 300 | 0 ×2, 40001 ×1 |');
    expect(md).toContain(
      '| trading | getAggregatedQuote | 1 | 1 | 100.0% | 5000 | 5000 | no response ×1 |',
    );
    expect(md).toContain('| fra | 3 | 1 | 200 | 300 |');
    expect(md).toContain('| unset | 1 | 1 | 5000 | 5000 |');
    expect(md).toContain('| rwa | 40001 | 1 | 2026-09-23T00:02:00.000Z | Parameter [x] error |');
  });

  it('says so when nothing has been recorded', () => {
    const md = renderMetricsMarkdown([], {
      generatedAt: new Date('2026-09-27T00:00:00Z'),
      since: null,
    });
    expect(md).toContain('0 HTTP attempts');
    expect(md).toContain('No failed calls recorded.');
  });
});

describe('summarizeCalls', () => {
  it('groups by endpoint with code counts and by region', () => {
    const base = {
      ts: '2026-09-24T00:00:00.000Z',
      method: 'GET',
      msg: null,
      requestId: null,
      retryCount: 0,
      fixturePath: null,
    };
    const summary = summarizeCalls([
      {
        ...base,
        region: 'fra',
        module: 'trading',
        endpoint: 'getAggregatedQuote',
        httpStatus: 200,
        code: '0',
        latencyMs: 100,
      },
      {
        ...base,
        region: 'fra',
        module: 'trading',
        endpoint: 'getAggregatedQuote',
        httpStatus: 200,
        code: '40375',
        latencyMs: 300,
      },
      {
        ...base,
        region: null,
        module: 'rwa',
        endpoint: 'getRwaTokenList',
        httpStatus: null,
        code: null,
        latencyMs: 15000,
      },
    ]);
    expect(summary.endpoints).toEqual([
      {
        module: 'rwa',
        endpoint: 'getRwaTokenList',
        calls: 1,
        errors: 1,
        p50Ms: 15000,
        p95Ms: 15000,
        codes: { 'no response': 1 },
      },
      {
        module: 'trading',
        endpoint: 'getAggregatedQuote',
        calls: 2,
        errors: 1,
        p50Ms: 100,
        p95Ms: 300,
        codes: { '0': 1, '40375': 1 },
      },
    ]);
    expect(summary.regions.map((r) => [r.region, r.calls])).toEqual([
      ['fra', 2],
      ['unset', 1],
    ]);
    // Percentiles are taken over every call, not averaged from the groups.
    expect(summary.total).toEqual({ calls: 3, errors: 2, p50Ms: 300, p95Ms: 15000 });
  });

  it('stays linear on a large api_calls window (60k rows well under a second)', () => {
    // Grouping used to copy the whole group for every row: 30k rows took ~5-9 s and blocked /dx.
    const n = 60_000;
    // 7919 is prime and coprime to 60,000, so the latencies are a permutation of 0..59,999.
    const records = Array.from({ length: n }, (_, i) =>
      call({
        endpoint: `endpoint${i % 3}`,
        latencyMs: (i * 7919) % n,
        code: i % 10 === 0 ? '40375' : '0',
      }),
    );
    const started = performance.now();
    const summary = summarizeCalls(records);
    const markdown = renderMetricsMarkdown(records, {
      generatedAt: new Date('2026-09-27T00:00:00Z'),
      since: null,
    });
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(summary.total).toEqual({ calls: n, errors: 6_000, p50Ms: 29_999, p95Ms: 56_999 });
    expect(summary.endpoints.map((e) => [e.endpoint, e.calls, e.codes])).toEqual([
      ['endpoint0', 20_000, { '0': 18_000, '40375': 2_000 }],
      ['endpoint1', 20_000, { '0': 18_000, '40375': 2_000 }],
      ['endpoint2', 20_000, { '0': 18_000, '40375': 2_000 }],
    ]);
    expect(summary.regions).toEqual([
      { region: 'fra', calls: n, errors: 6_000, p50Ms: 29_999, p95Ms: 56_999 },
    ]);
    expect(markdown).toContain('| fra | 60000 | 6000 | 29999 | 56999 |');
  });
});
