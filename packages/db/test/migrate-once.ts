/** Vitest global setup for @yieldvest/db: apply the migrations once, before any test file runs. */
import { createDb, migrateDb } from '../src/index.js';

export default async function migrateOnce(): Promise<void> {
  const url = process.env.YIELDVEST_TEST_DATABASE_URL;
  if (!url) return;
  const { db, close } = createDb(url);
  try {
    await migrateDb(db);
  } finally {
    await close();
  }
}
