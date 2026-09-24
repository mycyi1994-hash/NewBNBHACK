/**
 * pnpm tape:once — one tape run (TASKS M0-08): all instruments × $5/$50/$500 quotes → tape_samples.
 * Read-only against Binance (quotes only, nothing is swapped). Prints one line per row.
 */
import { createRuntime, maskHouse, sampleTape } from '@ijaro/agent';
import { loadConfig } from '@ijaro/config';
import { insertTapeSamples, listInstruments, migrateDb } from '@ijaro/db';

const rt = createRuntime(loadConfig());
try {
  await migrateDb(rt.database.db);
  const instruments = await listInstruments(rt.database.db);
  if (instruments.length === 0) {
    console.log('UNAVAILABLE: instruments table is empty — run pnpm registry first');
    process.exitCode = 3;
  } else {
    const rows = await sampleTape({
      client: rt.client,
      instruments,
      houseAddress: rt.houseAddress,
    });
    await insertTapeSamples(rt.database.db, rows);
    console.log(`tape:once — ${rows[0]?.sampledAt} — session ${rows[0]?.session}`);
    for (const r of rows) {
      const result = r.errorCode
        ? `ERR ${r.errorCode} ${maskHouse(r.errorMsg ?? '', rt.redact)}`
        : `out ${r.expectedOut} impact ${r.priceImpactPct}% ${r.vendor}/${r.executionMode} [${r.route}] ${r.latencyMs} ms`;
      console.log(
        `  ${r.instrumentId.padEnd(13)} $${String(r.sizeUsd).padEnd(3)} ${r.marketStatus ?? '-'}/${r.reasonCode ?? '-'} price ${r.tokenPrice} ref ${r.referencePrice} stock ${r.stockPrice ?? (r.stockPriceError ? `ERR ${r.stockPriceError}` : 'null')} — ${result}`,
      );
    }
    console.log(`tape_samples: ${rows.length} rows inserted`);
  }
} finally {
  await rt.close();
}
