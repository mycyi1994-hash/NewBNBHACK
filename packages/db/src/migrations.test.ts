/**
 * Migrations round-trip (TASKS M1-01, GOALS G3-1): up → down (every migration, newest first) → up
 * leaves the same schema. Runs in a database of its own, created and dropped here, because rolling
 * back drops the tables the other test files use.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl as url } from '../test/helpers.js';
import {
  appliedMigrations,
  createDb,
  downMigrationPath,
  migrateDb,
  migrationJournal,
  rollbackMigration,
  type Db,
} from './index.js';

const M1_TABLES = [
  'cycles',
  'guardian_events',
  'holdings',
  'jobs',
  'judge_codes',
  'plans',
  'receipts',
  'skill_tokens',
  'spend_ledger',
  'tx_outbox',
];

describe('migration files', () => {
  it('every generated migration has a hand-written inverse, and nothing else is there', () => {
    const tags = migrationJournal().map((m) => m.tag);
    expect(tags.length).toBeGreaterThanOrEqual(5);
    for (const tag of tags) expect(existsSync(downMigrationPath(tag)), tag).toBe(true);
    const downDir = path.dirname(downMigrationPath(tags[0] ?? ''));
    expect(readdirSync(downDir).sort()).toEqual(tags.map((t) => `${t}.sql`).sort());
  });
});

async function tableNames(db: Db): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(
    sql`select table_name as name from information_schema.tables where table_schema = 'public' order by 1`,
  );
  return rows.map((r) => r.name);
}

/** Columns, constraints and indexes of the public schema, in a stable order. */
async function schemaSnapshot(db: Db) {
  const columns = await db.execute(sql`
    select table_name, column_name, data_type, is_nullable, column_default, numeric_precision, numeric_scale
    from information_schema.columns where table_schema = 'public'
    order by table_name, ordinal_position`);
  const constraints = await db.execute(sql`
    select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
    from pg_constraint where connamespace = 'public'::regnamespace
    order by 1, 2`);
  const indexes = await db.execute(sql`
    select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`);
  return { columns: [...columns], constraints: [...constraints], indexes: [...indexes] };
}

describe.skipIf(!url)('migrations round trip on Postgres', () => {
  const admin = createDb(url ?? 'postgres://unused');
  const name = `ijaro_rt_${randomBytes(4).toString('hex')}`;
  let target: ReturnType<typeof createDb> | undefined;

  beforeAll(async () => {
    await admin.db.execute(sql.raw(`create database ${name}`));
    const targetUrl = new URL(url ?? '');
    targetUrl.pathname = `/${name}`;
    target = createDb(targetUrl.toString());
  });
  afterAll(async () => {
    await target?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${name} with (force)`));
    await admin.close();
  });

  it('up → down (all, newest first) → up gives back the same schema', async () => {
    const db = target?.db;
    if (!db) throw new Error('no target database');
    const tags = migrationJournal().map((m) => m.tag);

    await migrateDb(db);
    expect(await appliedMigrations(db)).toEqual(tags);
    const up = await schemaSnapshot(db);
    expect(await tableNames(db)).toEqual(
      [...M1_TABLES, 'api_calls', 'instruments', 'tape_samples'].sort(),
    );

    // Only the latest migration can be reverted.
    await expect(rollbackMigration(db, tags[0] ?? '')).rejects.toThrow(/only the latest/);

    await rollbackMigration(db, '0004_m1_core');
    expect(await tableNames(db)).toEqual(['api_calls', 'instruments', 'tape_samples']);
    expect(await appliedMigrations(db)).toEqual(tags.slice(0, -1));

    for (const tag of [...tags.slice(0, -1)].reverse()) await rollbackMigration(db, tag);
    expect(await tableNames(db)).toEqual([]);
    expect(await appliedMigrations(db)).toEqual([]);

    await migrateDb(db);
    expect(await appliedMigrations(db)).toEqual(tags);
    expect(await schemaSnapshot(db)).toEqual(up);
  });
});
