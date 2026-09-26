/**
 * Long-running worker (SPEC §5, §13): the tape recorder (M0-08, every 10 min) and the scheduler
 * tick (M1-06, every 5 min: outbox, awaiting cycles, guardian, web jobs, due plans).
 *
 * EXECUTION_MODE=simulate (the default) signs nothing. With EXECUTION_MODE=live the worker is the
 * one signer (SPEC §5 v2) and spends only for plans that are active — house plans are seeded
 * paused and activated by a person (pnpm plan:status --activate), within the configured caps.
 *
 * Restart safety: each scheduled tape run is keyed by its 10-minute slot (`tapeSlot`). A slot that
 * is already stored is skipped before any API call, and the insert is ON CONFLICT DO NOTHING on
 * (slot_at, instrument_id, size_usd), so a worker that dies and comes back never duplicates rows.
 */
import { assertUsdt } from '@ijaro/chain';
import { describeConfig, loadConfig } from '@ijaro/config';
import {
  insertTapeSamples,
  listInstruments,
  listPlans,
  migrateDb,
  tapeSlotRecorded,
} from '@ijaro/db';
import type { CycleDeps } from './cycle.js';
import { discoverVenusUsdt } from './executor/venus.js';
import { refreshRegistry } from './registry.js';
import { createRuntime, executorDeps } from './runtime.js';
import { schedulerTick, TICK_MS } from './scheduler.js';
import { msUntilNextSlot, sampleTape, tapeSlot } from './tape.js';

const REGISTRY_REFRESH_MS = 24 * 60 * 60 * 1000;

const config = loadConfig();
console.log(`agent: configuration valid — ${JSON.stringify(describeConfig(config))}`);

const rt = createRuntime(config);
await migrateDb(rt.database.db);
await assertUsdt(rt.bsc);

// The scheduler needs the house address; without it the worker only records the tape.
let cycleDeps: { deps: CycleDeps; simulate: CycleDeps } | undefined;
if (rt.houseAddress) {
  const deps = executorDeps(rt, config.executionMode);
  const simulate = config.executionMode === 'live' ? executorDeps(rt, 'simulate') : deps;
  try {
    deps.venus = simulate.venus = await discoverVenusUsdt(simulate);
  } catch (error) {
    console.log(
      `agent: Venus market UNAVAILABLE (${error instanceof Error ? error.message : String(error)}) — yield plans and the Venus guardian rules wait`,
    );
  }
  cycleDeps = { deps, simulate };
  const active = (await listPlans(rt.database.db))
    .filter((p) => p.status === 'active')
    .map((p) => p.id);
  console.log(
    config.executionMode === 'live'
      ? `agent: LIVE — the worker signs for active plans [${active.join(', ')}] within the caps`
      : `agent: simulate — nothing is signed; active plans [${active.join(', ')}]`,
  );
} else {
  console.log('agent: no HOUSE_WALLET_PRIVATE_KEY — scheduler off, tape only');
}

let ticking = false;
async function tick() {
  if (!cycleDeps || ticking) return;
  ticking = true;
  try {
    const report = await schedulerTick(cycleDeps.deps, cycleDeps.simulate);
    const cycles = report.cycles.map(
      (c) => `${c.planId}:${c.status}${'outcome' in c ? `:${c.outcome.kind}` : ''}`,
    );
    if (cycles.length || report.jobs.length || report.completed.length || report.errors.length) {
      console.log(
        `tick: ${report.at} cycles [${cycles.join(', ')}] jobs ${report.jobs.length} completed ${report.completed.length}` +
          (report.errors.length ? ` errors: ${report.errors.join('; ')}` : ''),
      );
    }
  } catch (error) {
    console.log(`tick: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    ticking = false;
  }
}

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
await tick();
setInterval(() => void tick(), TICK_MS);
console.log(`agent: scheduler registered (every ${TICK_MS / 60_000} min)`);
console.log('agent: tape job registered (every 10 min, keyed by slot); running current slot now');
await tapeTick();
schedule();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`agent: ${signal} — closing`);
    void rt.close().finally(() => process.exit(0));
  });
}
