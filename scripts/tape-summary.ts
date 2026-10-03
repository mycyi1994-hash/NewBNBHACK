/**
 * pnpm tape:summary [--days <n>] [--out <path>] — regenerate dx/tape-summary.md (DX_PROTOCOL §3.4)
 * from tape_samples: coverage, quote refusals and price impact per issuer, session and size, the
 * gap to the US price, the refusal codes and the token statuses seen — the numbers behind the DX
 * report's "tokenized-stock specifics". Default window: the last 30 days. Read-only.
 * Exit: 0 written · 2 usage · 3 UNAVAILABLE (no DATABASE_URL; the file is left untouched).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findWorkspaceRoot, loadConfig } from '@yieldvest/config';
import {
  createDb,
  TAPE_METHOD,
  tapeCoverage,
  tapeErrorCodes,
  tapeGapPercentiles,
  tapeStatusCodes,
  tapeSummary,
} from '@yieldvest/db';
import { parseFlags } from './args.js';
import { renderTapeSummary } from './tape-summary-render.js';

const flags = parseFlags(process.argv.slice(2), { values: ['days', 'out'] });
const days = flags.ok ? Number(flags.values.days ?? '30') : NaN;
const problem = !flags.ok
  ? flags.error
  : !Number.isInteger(days) || days < 1 || days > 365
    ? '--days needs a whole number of days from 1 to 365'
    : undefined;

if (!flags.ok || problem !== undefined) {
  console.log(`${problem}\nusage: pnpm tape:summary [--days <n>] [--out <path>]`);
  process.exitCode = 2;
} else {
  const root = findWorkspaceRoot() ?? process.cwd();
  const out = path.resolve(root, flags.values.out ?? 'dx/tape-summary.md');
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.log(`UNAVAILABLE: no DATABASE_URL — ${path.relative(root, out)} not regenerated`);
    process.exitCode = 3;
  } else {
    const now = new Date();
    const since = new Date(now.getTime() - days * 86_400_000);
    const { db, close } = createDb(config.databaseUrl);
    try {
      const [coverage, quotes, gaps, codes, statuses] = await Promise.all([
        tapeCoverage(db, since),
        tapeSummary(db, since),
        tapeGapPercentiles(db, since),
        tapeErrorCodes(db, since),
        tapeStatusCodes(db, since),
      ]);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(
        out,
        renderTapeSummary({
          generatedAt: now,
          since,
          method: TAPE_METHOD,
          coverage,
          quotes,
          gaps,
          codes,
          statuses,
        }),
      );
      console.log(
        `${path.relative(root, out)}: ${coverage.runs} runs, ${coverage.rows} rows, ${coverage.tokens} tokens (${coverage.first ?? '—'} → ${coverage.last ?? '—'})`,
      );
    } finally {
      await close();
    }
  }
}
