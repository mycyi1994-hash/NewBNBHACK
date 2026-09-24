/** Vitest global setup for @ijaro/db: apply the migrations once, before any test file runs. */
import { createDb, migrateDb } from '../src/index.js';

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
