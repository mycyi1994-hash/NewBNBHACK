/**
 * pnpm registry — build the `instruments` table from the RWA Data API (TASKS M0-05, D-07).
 * For each candidate ticker × issuer present on BSC: on-chain symbol/decimals must equal the API's,
 * bStocks uiMultiplier must equal tokenToShareRatio. Mismatches are reported and not written.
 * Flags: --fixtures (save the RWA list response under fixtures/rwa/).
 */
import { parseArgs } from 'node:util';
import {
  CANDIDATE_TICKERS,
  createRuntime,
  fetchRwaTokens,
  presenceMatrix,
  verifyToken,
} from '@ijaro/agent';
import { loadConfig } from '@ijaro/config';
import { listInstruments, migrateDb, upsertInstruments } from '@ijaro/db';

const { values: flags } = parseArgs({ options: { fixtures: { type: 'boolean', default: false } } });
const rt = createRuntime(loadConfig(), { fixtures: flags.fixtures });
try {
  await migrateDb(rt.database.db);
  const now = new Date();
  const tokens = await fetchRwaTokens(rt.client, { recordFixture: flags.fixtures });
  console.log(`registry — ${now.toISOString()} — ${tokens.length} RWA tokens on BSC`);

  const matrix = presenceMatrix(tokens, CANDIDATE_TICKERS);
  const issuers = [...new Set([...matrix.values()].flatMap((m) => [...m.keys()]))].sort();
  console.log(
    `\n| ticker | ${issuers.join(' | ')} |\n| --- |${issuers.map(() => ' --- |').join('')}`,
  );
  for (const [ticker, row] of matrix) {
    console.log(`| ${ticker} | ${issuers.map((i) => row.get(i)?.join(', ') ?? '—').join(' | ')} |`);
  }

  const candidates = tokens.filter((t) =>
    (CANDIDATE_TICKERS as readonly string[]).includes(t.underlyingTicker),
  );
  const accepted = [];
  console.log('\non-chain verification:');
  for (const token of candidates) {
    const v = await verifyToken(rt.bsc, token, now);
    console.log(
      `  ${v.ok ? 'OK  ' : 'FAIL'} ${token.tokenSymbol.padEnd(7)} ${v.checks.join('; ')}`,
    );
    if (v.ok && v.row) accepted.push(v.row);
  }
  await upsertInstruments(rt.database.db, accepted);
  const all = await listInstruments(rt.database.db);
  console.log(
    `\ninstruments: ${accepted.length} verified rows upserted, ${all.length} rows in table` +
      (rt.sinkErrors.length ? ` (api_calls sink errors: ${rt.sinkErrors.length})` : ''),
  );
  if (accepted.length !== candidates.length) process.exitCode = 1;
} finally {
  await rt.close();
}
