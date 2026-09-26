/**
 * First-sighting DX events (SPEC §10, TASKS M1-07). Wraps the api_calls sink: a record whose code
 * or response shape the official docs do not list is stored in dx_events, and its first sighting
 * alerts ops. `pnpm dx:events` prints the findings in the dx/LOG.md format (facts only).
 */
import { dxFindingOf, type ApiCallSink } from '@ijaro/binance';
import type { DxEventInsert } from '@ijaro/db';
import type { Alerter } from './alerts.js';

export interface DxWatchDeps {
  /** Stores the finding; true on its first sighting (recordDxEvent). */
  record: (event: DxEventInsert) => Promise<boolean>;
  alerter: Alerter;
}

export function watchDxFindings(inner: ApiCallSink, deps: DxWatchDeps): ApiCallSink {
  return async (call) => {
    await inner(call);
    const finding = dxFindingOf(call);
    if (!finding) return;
    const code = call.code ?? '';
    const first = await deps.record({
      ts: call.ts,
      kind: finding.kind,
      module: call.module,
      endpoint: call.endpoint,
      code,
      httpStatus: call.httpStatus,
      msg: call.msg,
      requestId: call.requestId,
      region: call.region,
      meaning: finding.meaning,
    });
    if (!first) return;
    await deps.alerter.send({
      key: `dx:${finding.kind}:${call.module}:${call.endpoint}:${code}`,
      text:
        `[ijaro dx] first sighting — ${call.module}/${call.endpoint}: ${finding.meaning} ` +
        `(HTTP ${call.httpStatus ?? '-'}, msg "${call.msg ?? ''}", request id ${call.requestId ?? '-'}). ` +
        'Log it with pnpm dx:events.',
    });
  };
}
