/** pnpm db:migrate — apply packages/db/drizzle migrations to DATABASE_URL. */
import { loadConfig } from '@ijaro/config';
import { createDb, migrateDb } from '@ijaro/db';

const config = loadConfig();
if (!config.databaseUrl) {
  console.log('UNAVAILABLE: no DATABASE_URL — nothing migrated');
  process.exitCode = 3;
} else {
  const { db, close } = createDb(config.databaseUrl);
  try {
    await migrateDb(db);
    console.log(
      `migrated ${new URL(config.databaseUrl).host}${new URL(config.databaseUrl).pathname}`,
    );
  } finally {
    await close();
  }
}
