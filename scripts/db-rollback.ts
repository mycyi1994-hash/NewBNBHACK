/**
 * pnpm db:rollback <tag> --yes — reverts the latest applied migration with its hand-written inverse
 * (packages/db/drizzle-down/<tag>.sql). Destructive: the tables it created are dropped with their
 * rows, so it refuses without --yes. For development databases and the RUNBOOK recovery drill.
 */
import { loadConfig } from '@yieldvest/config';
import { appliedMigrations, createDb, rollbackMigration } from '@yieldvest/db';

const args = process.argv.slice(2).filter((a) => a !== '--');
const tag = args.find((a) => !a.startsWith('--'));
const config = loadConfig();
if (!config.databaseUrl) {
  console.log('UNAVAILABLE: no DATABASE_URL — nothing rolled back');
  process.exitCode = 3;
} else {
  const { db, close } = createDb(config.databaseUrl);
  try {
    const applied = await appliedMigrations(db);
    console.log(`applied: ${applied.join(', ') || '(none)'}`);
    if (!tag) {
      console.log('usage: pnpm db:rollback <tag> --yes   (tag = the latest applied migration)');
      process.exitCode = 2;
    } else if (!args.includes('--yes')) {
      console.log(`refused: rolling back ${tag} drops its tables and rows; add --yes to confirm`);
      process.exitCode = 2;
    } else {
      try {
        await rollbackMigration(db, tag);
        console.log(`rolled back ${tag}; applied now: ${(await appliedMigrations(db)).join(', ')}`);
      } catch (error) {
        console.log(`refused: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await close();
  }
}
