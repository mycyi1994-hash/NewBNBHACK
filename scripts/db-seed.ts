/**
 * pnpm db:seed — the house plans H-SAFE and H-YIELD (paused until the house wallet is funded) and
 * the judge codes from JUDGE_CODES (stored as SHA-256 hashes, missing ones disabled). Migrates
 * first; never overwrites a plan that exists.
 */
import { loadConfig } from '@ijaro/config';
import { nextRegularOpen, OPEN_SETTLE_MS } from '@ijaro/core';
import { createDb, migrateDb, seedHousePlans, syncJudgeCodes } from '@ijaro/db';

const config = loadConfig();
if (!config.databaseUrl) {
  console.log('UNAVAILABLE: no DATABASE_URL — nothing seeded');
  process.exitCode = 3;
} else {
  const { db, close } = createDb(config.databaseUrl);
  try {
    await migrateDb(db);
    const firstDue = new Date(nextRegularOpen(new Date()).getTime() + OPEN_SETTLE_MS);
    const plans = await seedHousePlans(db, firstDue.toISOString());
    const codes = await syncJudgeCodes(db, config.judgeCodes);
    console.log(
      `house plans: created [${plans.created.join(', ')}], kept [${plans.kept.join(', ')}]` +
        ` (new plans paused: awaiting_funding, first due ${firstDue.toISOString()})`,
    );
    console.log(`judge codes: ${codes} active (hashes only)`);
  } finally {
    await close();
  }
}
