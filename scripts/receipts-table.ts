/**
 * pnpm receipts:table [--limit 20] — the README's receipts table (TASKS M3-03), generated from the
 * database: every on-chain action with its plan, reason key and BscScan link. Prints markdown;
 * nothing is written anywhere. Wallet addresses never appear (receipts hold hashes, not owners).
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '@yieldvest/config';
import { createDb, getCycle, getPlan, isoTime, listReceipts } from '@yieldvest/db';

const { values } = parseArgs({ options: { limit: { type: 'string', default: '20' } } });
const config = loadConfig();
if (!config.databaseUrl) {
  console.log('UNAVAILABLE: no DATABASE_URL');
  process.exitCode = 3;
} else {
  const { db, close } = createDb(config.databaseUrl);
  try {
    const rows = await listReceipts(db, { limit: Math.min(100, Number(values.limit) || 20) });
    console.log('| When (UTC) | Plan | Action | Outcome · reason | Receipt |');
    console.log('| --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const [plan, cycle] = await Promise.all([
        getPlan(db, r.planId),
        r.cycleId ? getCycle(db, r.cycleId) : undefined,
      ]);
      const reason = cycle?.whyKey ? `${cycle.outcomeKind ?? ''} · \`${cycle.whyKey}\`` : '—';
      console.log(
        `| ${isoTime(r.createdAt).slice(0, 16).replace('T', ' ')} | ${plan?.ownerKind ?? '?'} ${plan?.ticker ?? ''} ${plan?.mode ?? ''} | ${r.kind} | ${reason} | [${r.txHash.slice(0, 10)}…](${r.explorerUrl}) |`,
      );
    }
    if (rows.length === 0) console.log('| — | — | — | no receipts yet | — |');
  } finally {
    await close();
  }
}
