/**
 * pnpm db:count [table…] — read-only row counts (evidence for TASKS acceptance: "SELECT count").
 * Prints the exact SQL it runs. Default tables: api_calls, instruments, tape_samples.
 */
import { loadConfig } from '@ijaro/config';
import postgres from 'postgres';

const ALLOWED = ['api_calls', 'instruments', 'tape_samples'] as const;
const requested = process.argv.slice(2).filter((a) => a !== '--');
const tables = requested.length > 0 ? requested : [...ALLOWED];

const config = loadConfig();
if (!config.databaseUrl) {
  console.log('UNAVAILABLE: no DATABASE_URL');
  process.exitCode = 3;
} else {
  const sql = postgres(config.databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    console.log(`db:count — ${new Date().toISOString()}`);
    for (const table of tables) {
      if (!(ALLOWED as readonly string[]).includes(table)) {
        console.log(`${table}: refused (allowed: ${ALLOWED.join(', ')})`);
        process.exitCode = 1;
        continue;
      }
      const exists = await sql`select to_regclass(${table}) as t`;
      if (exists[0]?.t === null) {
        console.log(`SELECT count(*) FROM ${table}; → table missing (run pnpm db:migrate)`);
        continue;
      }
      const rows = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from ${table}`);
      console.log(`SELECT count(*) FROM ${table}; → ${rows[0]?.n}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
