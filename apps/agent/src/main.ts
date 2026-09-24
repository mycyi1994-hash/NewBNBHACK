/**
 * Long-running worker (SPEC §5). Jobs are registered by their tickets: tape recorder (M0-08),
 * 5-minute cycle scheduler (M1-06), guardian (M2-06). Nothing here signs or broadcasts.
 */
import { assertUsdt } from '@ijaro/chain';
import { describeConfig, loadConfig } from '@ijaro/config';
import { insertTapeSamples, listInstruments } from '@ijaro/db';
import { createRuntime } from './runtime.js';
import { msUntilNextSlot, sampleTape } from './tape.js';

const config = loadConfig();
console.log(`agent: configuration valid — ${JSON.stringify(describeConfig(config))}`);
if (config.executionMode !== 'simulate') {
  // M0 has no spending path; refuse rather than pretend.
  console.log('agent: EXECUTION_MODE=live is not supported before M1 — exiting');
  process.exit(1);
}

const rt = createRuntime(config);
await assertUsdt(rt.bsc);

let running = false;
async function tapeTick() {
  if (running) {
    console.log(`tape: ${new Date().toISOString()} previous run still going — skipped`);
    return;
  }
  running = true;
  try {
    const instruments = await listInstruments(rt.database.db);
    if (instruments.length === 0) {
      console.log('tape: UNAVAILABLE — instruments table is empty (run pnpm registry)');
      return;
    }
    const rows = await sampleTape({
      client: rt.client,
      instruments,
      houseAddress: rt.houseAddress,
    });
    await insertTapeSamples(rt.database.db, rows);
    const errors = rows.filter((r) => r.errorCode).length;
    console.log(
      `tape: ${rows[0]?.sampledAt} ${rows.length} rows (${instruments.length} instruments × sizes), ${errors} quote errors, session ${rows[0]?.session}`,
    );
  } catch (error) {
    console.log(`tape: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
  }
}

function schedule() {
  const wait = msUntilNextSlot(new Date());
  setTimeout(() => {
    void tapeTick().finally(schedule);
  }, wait);
  console.log(`tape: next run in ${Math.round(wait / 1000)} s`);
}

console.log('agent: tape job registered (every 10 min, aligned to :00/:10/…); first run now');
await tapeTick();
schedule();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`agent: ${signal} — closing`);
    void rt.close().finally(() => process.exit(0));
  });
}
