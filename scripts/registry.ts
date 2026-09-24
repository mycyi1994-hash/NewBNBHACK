/**
 * pnpm registry — build the `instruments` table from the RWA Data API (TASKS M0-05, D-07).
 * For each candidate ticker × issuer present on BSC: on-chain symbol/decimals must equal the API's,
 * bStocks uiMultiplier must equal tokenToShareRatio. Mismatches are reported and not written.
 * Flags: --fixtures (save the RWA list response under fixtures/rwa/).
 */
import { parseArgs } from 'node:util';
import { createRuntime, refreshRegistry } from '@ijaro/agent';
import { loadConfig } from '@ijaro/config';
import { migrateDb } from '@ijaro/db';

const { values: flags } = parseArgs({ options: { fixtures: { type: 'boolean', default: false } } });
const rt = createRuntime(loadConfig(), { fixtures: flags.fixtures });
try {
  await migrateDb(rt.database.db);
  const now = new Date();
  const result = await refreshRegistry(
    { client: rt.client, bsc: rt.bsc, db: rt.database.db },
    { recordFixture: flags.fixtures, now },
  );
  console.log(`registry — ${now.toISOString()} — ${result.tokenCount} RWA tokens on BSC`);

  const issuers = [...new Set([...result.matrix.values()].flatMap((m) => [...m.keys()]))].sort();
  console.log(
    `\n| ticker | ${issuers.join(' | ')} |\n| --- |${issuers.map(() => ' --- |').join('')}`,
  );
  for (const [ticker, row] of result.matrix) {
    console.log(`| ${ticker} | ${issuers.map((i) => row.get(i)?.join(', ') ?? '—').join(' | ')} |`);
  }

  console.log('\non-chain verification:');
  for (const v of result.verifications) {
    console.log(
      `  ${v.ok ? 'OK  ' : 'FAIL'} ${v.token.tokenSymbol.padEnd(7)} ${v.checks.join('; ')}`,
    );
  }
  console.log(
    `\ninstruments: ${result.upserted} verified rows upserted, ${result.total} rows in table` +
      (rt.sinkErrors.length ? ` (api_calls sink errors: ${rt.sinkErrors.length})` : ''),
  );
  if (result.upserted !== result.verifications.length) process.exitCode = 1;
} finally {
  await rt.close();
}
