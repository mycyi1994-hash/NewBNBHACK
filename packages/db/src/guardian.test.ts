/** Guardian history on Postgres: samples near a time, and how long a value has stayed low. */
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl as url } from '../test/helpers.js';
import {
  belowSince,
  createDb,
  guardianEvents,
  guardianSamples,
  insertGuardianEvent,
  insertGuardianSample,
  isoTime,
  openGuardianActions,
  resolveGuardianEvents,
  sampleNear,
  usdText,
} from './index.js';

describe.skipIf(!url)('guardian history on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const source = `test-${Date.now()}`;
  afterAll(async () => {
    await db.delete(guardianSamples).where(eq(guardianSamples.source, source));
    await db.delete(guardianEvents).where(eq(guardianEvents.rule, `rule-${source}`));
    await close();
  });

  it('finds the sample closest to a time, within a tolerance', async () => {
    // Far-past timestamps keep this test apart from anything else in the table.
    for (const [ts, value] of [
      ['2001-01-01T10:00:00Z', '1000'],
      ['2001-01-01T11:00:00Z', '1100'],
      ['2001-01-02T10:05:00Z', '690'],
    ] as const) {
      await insertGuardianSample(db, { ts, metric: 'venus_tvl_usd', value, source });
    }
    const dayAgo = await sampleNear(
      db,
      'venus_tvl_usd',
      source,
      new Date('2001-01-01T10:10:00Z'),
      60 * 60_000,
    );
    expect(dayAgo && usdText(dayAgo.value)).toBe('1000');
    expect(
      await sampleNear(db, 'venus_tvl_usd', source, new Date('2001-01-01T20:00:00Z'), 60 * 60_000),
    ).toBeUndefined();
  });

  it('tells since when a price has stayed below the peg', async () => {
    const metric = 'usdt_price_usd' as const;
    expect(await belowSince(db, metric, source, '0.99')).toBeUndefined();
    await insertGuardianSample(db, { ts: '2001-02-01T10:00:00Z', metric, value: '0.998', source });
    await insertGuardianSample(db, { ts: '2001-02-01T10:05:00Z', metric, value: '0.985', source });
    await insertGuardianSample(db, { ts: '2001-02-01T10:10:00Z', metric, value: '0.984', source });
    const since = await belowSince(db, metric, source, '0.99');
    expect(since && isoTime(since)).toBe('2001-02-01T10:05:00.000Z');
    await insertGuardianSample(db, { ts: '2001-02-01T10:15:00Z', metric, value: '0.995', source });
    expect(await belowSince(db, metric, source, '0.99')).toBeUndefined();
  });

  it('lists open verdicts until the rule resolves', async () => {
    const rule = `rule-${source}`;
    // 'warn' never blocks a buy, so this cannot disturb a cycle running elsewhere.
    await insertGuardianEvent(db, { rule, action: 'warn', detail: {} });
    expect(await openGuardianActions(db)).toContainEqual({ rule, action: 'warn' });
    await resolveGuardianEvents(db, rule, new Date());
    expect(await openGuardianActions(db)).not.toContainEqual({ rule, action: 'warn' });
  });
});
