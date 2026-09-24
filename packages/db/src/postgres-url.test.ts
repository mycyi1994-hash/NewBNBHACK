import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, postgresUrl } from './index.js';

describe('postgresUrl', () => {
  it('drops the channel_binding parameter from a Neon console connection string', () => {
    expect(
      postgresUrl(
        'postgresql://neondb_owner:npg_AbC123@ep-cool-name-a1b2c3d4.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
      ),
    ).toBe(
      'postgresql://neondb_owner:npg_AbC123@ep-cool-name-a1b2c3d4.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    );
  });

  it('keeps the other parameters, their order and the encoded password', () => {
    expect(
      postgresUrl(
        'postgres://u:p%40ss@db.example:5432/app?channel_binding=require&options=endpoint%3Dep-x&sslmode=require',
      ),
    ).toBe('postgres://u:p%40ss@db.example:5432/app?options=endpoint%3Dep-x&sslmode=require');
  });

  it('returns every other URL byte for byte', () => {
    for (const url of [
      'postgres://postgres:ijaro@127.0.0.1:5433/ijaro',
      'postgres://u:p%40ss@db.example/app?sslmode=require',
      'not a url',
    ]) {
      expect(postgresUrl(url)).toBe(url);
    }
  });
});

const url = process.env.IJARO_TEST_DATABASE_URL;

describe.skipIf(!url)('createDb on Postgres', () => {
  it('connects with a URL that carries channel_binding=require', async () => {
    const neonStyle = new URL(url ?? 'postgres://unused');
    neonStyle.searchParams.set('channel_binding', 'require');
    const { db, close } = createDb(neonStyle.toString());
    try {
      const rows = await db.execute<{ ok: number }>(sql`select 1 as ok`);
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await close();
    }
  });
});
