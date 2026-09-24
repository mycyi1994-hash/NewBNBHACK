import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  createDb,
  insertTapeSamples,
  migrateDb,
  tapeSamples,
  tapeSlotRecorded,
  type TapeSampleInsert,
} from './index.js';

const url = process.env.IJARO_TEST_DATABASE_URL;

describe.skipIf(!url)('tape_samples idempotency on Postgres', () => {
  it('writes a slot once; a restarted worker re-running the slot writes nothing', async () => {
    const { db, close } = createDb(url ?? 'postgres://unused');
    // A slot far in the past that no real run uses; removed afterwards.
    const slotAt = new Date(Date.UTC(2000, 0, 1, 0, Math.floor(Math.random() * 1e6))).toISOString();
    const row = (sizeUsd: number): TapeSampleInsert => ({
      sampledAt: slotAt,
      slotAt,
      instrumentId: 'TEST:idempotency',
      session: 'weekend',
      sizeUsd,
    });
    try {
      await migrateDb(db);
      expect(await tapeSlotRecorded(db, slotAt)).toBe(false);
      expect(await insertTapeSamples(db, [row(5), row(50)])).toBe(2);
      expect(await tapeSlotRecorded(db, slotAt)).toBe(true);
      expect(await insertTapeSamples(db, [row(5), row(50), row(500)])).toBe(1);
      const stored = await db.select().from(tapeSamples).where(eq(tapeSamples.slotAt, slotAt));
      expect(stored.map((r) => r.sizeUsd).sort((a, b) => a - b)).toEqual([5, 50, 500]);
    } finally {
      await db.delete(tapeSamples).where(eq(tapeSamples.slotAt, slotAt));
      await close();
    }
  });
});
