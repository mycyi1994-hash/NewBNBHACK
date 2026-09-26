/** Vitest global setup for @ijaro/agent: migrate the test database before its DB tests run. */
import { createDb, migrateDb } from '@ijaro/db';

export default async function migrateOnce(): Promise<void> {
  const url = process.env.IJARO_TEST_DATABASE_URL;
  if (!url) return;
  const { db, close } = createDb(url);
  try {
    await migrateDb(db);
  } finally {
    await close();
  }
}
