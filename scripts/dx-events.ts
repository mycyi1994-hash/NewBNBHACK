/**
 * pnpm dx:events [--all] [--mark-logged] — the first sightings of undocumented error codes and
 * response shapes (dx_events, M1-07), printed in the dx/LOG.md entry format of DX_PROTOCOL §3.1.
 * Facts only: the human adds the "소감" line. --mark-logged records that they were copied.
 */
import { loadConfig } from '@ijaro/config';
import { createDb, isoTime, listDxEvents, markDxEventsLogged, type DxEventRow } from '@ijaro/db';

const args = process.argv.slice(2);
const all = args.includes('--all');
const markLogged = args.includes('--mark-logged');

function utcMinute(ts: string): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

function entry(event: DxEventRow): string {
  const shape =
    event.kind === 'unknown_code'
      ? `undocumented code ${event.code}`
      : 'undocumented response shape';
  return [
    `## ${utcMinute(event.ts)} UTC — [web3api][error] ${event.module}/${event.endpoint}: ${shape}`,
    `- 기대: ${event.kind === 'unknown_code' ? `a code listed in the ${event.module} Error Codes table` : 'the documented {code, msg, data} envelope'}`,
    `- 실제: HTTP ${event.httpStatus ?? '-'}, code ${event.code || '-'}, msg "${event.msg ?? ''}", request id ${event.requestId ?? '-'}, region ${event.region ?? '-'}`,
    `- 분류: ${event.meaning} (dx_events #${event.id}, first sighting ${isoTime(event.ts)})`,
    `- 증거: api_calls where endpoint = '${event.endpoint}' and ts = '${isoTime(event.ts)}'`,
  ].join('\n');
}

const config = loadConfig();
if (!config.databaseUrl) {
  console.log('UNAVAILABLE: no DATABASE_URL');
  process.exitCode = 3;
} else {
  const { db, close } = createDb(config.databaseUrl);
  try {
    const events = await listDxEvents(db, { unloggedOnly: !all });
    if (events.length === 0) {
      console.log(
        all ? 'dx_events: none recorded' : 'dx_events: nothing new since the last --mark-logged',
      );
    } else {
      console.log(events.map(entry).join('\n\n'));
      if (markLogged) {
        await markDxEventsLogged(
          db,
          events.map((e) => e.id),
        );
        console.log(`\nmarked ${events.length} finding(s) as logged`);
      }
    }
  } finally {
    await close();
  }
}
