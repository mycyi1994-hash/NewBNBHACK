import { describe, expect, it } from 'vitest';
import { isSuccess, percentile, renderMetricsMarkdown } from './metrics.js';
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
