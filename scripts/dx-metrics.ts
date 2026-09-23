/**
 * pnpm dx:metrics — regenerate dx/metrics.md from the api_calls table (DX_PROTOCOL §3.2).
 * Flags: --since <ISO date> (only newer calls), --out <path> (default dx/metrics.md).
 * Exit: 0 written · 3 UNAVAILABLE (no DATABASE_URL; the file is left untouched).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { renderMetricsMarkdown } from '@ijaro/binance';
import { findWorkspaceRoot, loadConfig } from '@ijaro/config';
import { createDb, listApiCalls } from '@ijaro/db';

const { values: flags } = parseArgs({
  options: { since: { type: 'string' }, out: { type: 'string' } },
});
const root = findWorkspaceRoot() ?? process.cwd();
const out = path.resolve(root, flags.out ?? 'dx/metrics.md');
const since = flags.since ? new Date(flags.since) : null;
if (since && Number.isNaN(since.getTime()))
  throw new Error(`--since is not a date: ${flags.since}`);

const config = loadConfig();
if (!config.databaseUrl) {
  console.log(`UNAVAILABLE: no DATABASE_URL — ${path.relative(root, out)} not regenerated`);
  process.exitCode = 3;
} else {
  const { db, close } = createDb(config.databaseUrl);
  try {
    const records = await listApiCalls(db, since ?? undefined);
    await writeFile(out, renderMetricsMarkdown(records, { generatedAt: new Date(), since }));
    console.log(`${path.relative(root, out)}: ${records.length} api_calls rows summarized`);
  } finally {
    await close();
  }
}
