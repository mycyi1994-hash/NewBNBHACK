/** Vitest global setup for @ijaro/web: create and migrate the web tests' own database. */
import { createDb, migrateDb } from '@ijaro/db';
import { sql } from 'drizzle-orm';
import { webDatabaseUrl } from './db';

export default async function migrateOnce(): Promise<void> {
  const base = process.env.IJARO_TEST_DATABASE_URL;
  if (!base) return;
  const target = webDatabaseUrl(base);
  const name = new URL(target).pathname.slice(1);
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`unexpected test database name ${name}`);
  const admin = createDb(base);
  try {
    const rows = await admin.db.execute<{ found: number }>(
      sql`select 1 as found from pg_database where datname = ${name}`,
    );
    if (rows.length === 0) await admin.db.execute(sql.raw(`create database ${name}`));
  } finally {
    await admin.close();
  }
  const { db, close } = createDb(target);
  try {
    await migrateDb(db);
  } finally {
    await close();
  }
}
