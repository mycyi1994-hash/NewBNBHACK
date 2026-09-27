/** First-sighting DX events: store every finding, alert only the first time. */
import type { ApiCallRecord } from '@yieldvest/binance';
import type { DxEventInsert } from '@yieldvest/db';
import { describe, expect, it } from 'vitest';
import { createAlerter } from './alerts.js';
import { watchDxFindings } from './dx-watch.js';

const call = (overrides: Partial<ApiCallRecord> = {}): ApiCallRecord => ({
  ts: '2026-09-28T13:32:01.000Z',
  region: 'fra',
  module: 'trading',
  endpoint: 'getAggregatedQuote',
  method: 'GET',
  httpStatus: 200,
  code: '0',
  msg: 'success',
  latencyMs: 120,
  requestId: 'req-9',
  retryCount: 0,
  fixturePath: null,
  ...overrides,
});

function harness() {
  const stored: ApiCallRecord[] = [];
  const events: DxEventInsert[] = [];
  const seen = new Set<string>();
  const lines: string[] = [];
  const sink = watchDxFindings((r) => void stored.push(r), {
    record: (event) => {
      events.push(event);
      const key = `${event.kind}:${event.module}:${event.endpoint}:${event.code}`;
      const first = !seen.has(key);
      seen.add(key);
      return Promise.resolve(first);
    },
    alerter: createAlerter({ log: (line) => lines.push(line) }),
  });
  return { sink, stored, events, lines };
}

describe('watchDxFindings', () => {
  it('passes every call through and ignores documented outcomes', async () => {
    const h = harness();
    await h.sink(call());
    await h.sink(call({ code: '40375', msg: 'Minimum order amount is 5 USD.' }));
    expect(h.stored).toHaveLength(2);
    expect(h.events).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  it('records an undocumented code and alerts on its first sighting only', async () => {
    const h = harness();
    const odd = call({ code: '40999', msg: 'Something new' });
    await h.sink(odd);
    await h.sink({ ...odd, ts: '2026-09-28T13:42:01.000Z' });
    expect(h.events).toHaveLength(2);
    expect(h.events[0]).toEqual({
      ts: '2026-09-28T13:32:01.000Z',
      kind: 'unknown_code',
      module: 'trading',
      endpoint: 'getAggregatedQuote',
      code: '40999',
      httpStatus: 200,
      msg: 'Something new',
      requestId: 'req-9',
      region: 'fra',
      meaning: 'code 40999 is not in the trading error table',
    });
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('first sighting — trading/getAggregatedQuote');
  });

  it('records an error response that is not an envelope', async () => {
    const h = harness();
    await h.sink(call({ httpStatus: 403, code: null, msg: 'non-JSON body (1432 chars)' }));
    expect(h.events[0]).toMatchObject({ kind: 'undocumented_shape', code: '', httpStatus: 403 });
  });
});
