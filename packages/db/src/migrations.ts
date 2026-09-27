/**
 * Migrations in both directions. drizzle-kit writes only the up direction (`drizzle/<tag>.sql`);
 * each has a hand-written inverse in `drizzle-down/<tag>.sql`. A rollback runs the inverse and
 * deletes drizzle's bookkeeping row in one transaction, so the next `migrateDb` applies it again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'drizzle');
const DOWN_MIGRATIONS = path.join(ROOT, 'drizzle-down');
const BREAKPOINT = '--> statement-breakpoint';

export interface MigrationEntry {
  tag: string;
  /** drizzle's `created_at` for the migration (journal `when`). */
  when: number;
}

/** pg_advisory_lock key held while migrating. */
const MIGRATION_LOCK = 471_203_002;

/**
 * Applies pending migrations. Concurrent callers (two workers booting, parallel test projects on
 * a fresh database) queue on an advisory lock held on one reserved connection, so the second
 * finds everything applied instead of racing to create the same tables (ci run #8).
 */
export async function migrateDb(db: Db): Promise<void> {
  const connection = await db.$client.reserve();
  try {
    await connection`select pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(db, { migrationsFolder: MIGRATIONS });
  } finally {
    await connection`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    connection.release();
  }
}

/** Every migration drizzle-kit generated, oldest first. */
export function migrationJournal(): MigrationEntry[] {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: MigrationEntry[] };
  return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

/** Path of the hand-written inverse of `tag`. */
export function downMigrationPath(tag: string): string {
  return path.join(DOWN_MIGRATIONS, `${tag}.sql`);
}

/** Tags applied to this database, oldest first; unknown bookkeeping rows are reported as such. */
export async function appliedMigrations(db: Db): Promise<string[]> {
  const [table] = await db.execute<{ name: string | null }>(
    sql`select to_regclass('drizzle.__drizzle_migrations')::text as name`,
  );
  if (!table?.name) return [];
  const rows = await db.execute<{ created_at: string }>(
    sql`select created_at::text as created_at from drizzle.__drizzle_migrations order by created_at`,
  );
  const byWhen = new Map(migrationJournal().map((m) => [String(m.when), m.tag]));
  return rows.map((row) => byWhen.get(row.created_at) ?? `unknown@${row.created_at}`);
}

/** Reverts `tag`, which must be the latest applied migration. */
export async function rollbackMigration(db: Db, tag: string): Promise<void> {
  const applied = await appliedMigrations(db);
  const latest = applied.at(-1);
  if (latest !== tag) {
    throw new Error(
      `only the latest applied migration (${latest ?? 'none'}) can be rolled back, not ${tag}`,
    );
  }
  const entry = migrationJournal().find((m) => m.tag === tag);
  if (!entry) throw new Error(`${tag} is not in the migration journal`);
  const statements = readFileSync(downMigrationPath(tag), 'utf8')
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
  await db.transaction(async (tx) => {
    // The same lock as migrateDb: a worker booting mid-rollback waits instead of re-applying.
    await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    for (const statement of statements) await tx.execute(sql.raw(statement));
    await tx.execute(
      sql`delete from drizzle.__drizzle_migrations where created_at = ${entry.when}`,
    );
  });
}
