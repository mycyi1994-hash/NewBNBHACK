/**
 * Long-running worker (SPEC §5, §13). Jobs are registered by their tickets: tape recorder (M0-08),
 * 5-minute cycle scheduler (M1-06), guardian (M2-06). Nothing here signs or broadcasts.
 *
 * Restart safety: each scheduled tape run is keyed by its 10-minute slot (`tapeSlot`). A slot that
 * is already stored is skipped before any API call, and the insert is ON CONFLICT DO NOTHING on
 * (slot_at, instrument_id, size_usd), so a worker that dies and comes back never duplicates rows.
 */
import { assertUsdt } from '@ijaro/chain';
import { describeConfig, loadConfig } from '@ijaro/config';
import { insertTapeSamples, listInstruments, migrateDb, tapeSlotRecorded } from '@ijaro/db';
import { refreshRegistry } from './registry.js';
import { createRuntime } from './runtime.js';
import { msUntilNextSlot, sampleTape, tapeSlot } from './tape.js';

const REGISTRY_REFRESH_MS = 24 * 60 * 60 * 1000;

const config = loadConfig();
console.log(`agent: configuration valid — ${JSON.stringify(describeConfig(config))}`);
if (config.executionMode !== 'simulate') {
  // M0 has no spending path; refuse rather than pretend.
  console.log('agent: EXECUTION_MODE=live is not supported before M1 — exiting');
  process.exit(1);
}

const rt = createRuntime(config);
await migrateDb(rt.database.db);
await assertUsdt(rt.bsc);

async function registryTick() {
  try {
    const r = await refreshRegistry({ client: rt.client, bsc: rt.bsc, db: rt.database.db });
    const failed = r.verifications.filter((v) => !v.ok).map((v) => v.token.tokenSymbol);
    console.log(
      `registry: ${r.upserted}/${r.verifications.length} verified, ${r.total} instruments` +
        (failed.length ? `, FAILED ${failed.join(', ')}` : ''),
    );
  } catch (error) {
    console.log(`registry: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  }
}

let running = false;
async function tapeTick() {
  if (running) {
    console.log(`tape: ${new Date().toISOString()} previous run still going — skipped`);
    return;
  }
  running = true;
  const slot = tapeSlot(new Date());
  try {
    if (await tapeSlotRecorded(rt.database.db, slot.toISOString())) {
      console.log(`tape: slot ${slot.toISOString()} already recorded — skipped`);
      return;
    }
    const instruments = await listInstruments(rt.database.db);
    if (instruments.length === 0) {
      console.log('tape: UNAVAILABLE — instruments table is empty (registry failed?)');
      return;
    }
    const rows = await sampleTape({
      client: rt.client,
      instruments,
      houseAddress: rt.houseAddress,
      slotAt: slot,
    });
    const written = await insertTapeSamples(rt.database.db, rows);
    const errors = rows.filter((r) => r.errorCode).length;
    console.log(
      `tape: slot ${slot.toISOString()} sampled ${rows[0]?.sampledAt} ${written}/${rows.length} rows written (${instruments.length} instruments × sizes), ${errors} quote errors, session ${rows[0]?.session}`,
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

await registryTick();
setInterval(() => void registryTick(), REGISTRY_REFRESH_MS);
console.log('agent: tape job registered (every 10 min, keyed by slot); running current slot now');
await tapeTick();
schedule();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`agent: ${signal} — closing`);
    void rt.close().finally(() => process.exit(0));
  });
}
