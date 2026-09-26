/** Tape aggregates on Postgres: impact, errors and the price gap per session, size and issuer. */
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl as url } from '../test/helpers.js';
import {
  createDb,
  insertTapeSamples,
  instruments,
  tapeSamples,
  tapeSummary,
  upsertInstruments,
} from './index.js';

describe.skipIf(!url)('tapeSummary on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const ticker = `S${randomUUID().slice(0, 6)}`;
  const id = `${ticker}:bstocks`;
  afterAll(async () => {
    await db.delete(tapeSamples).where(inArray(tapeSamples.instrumentId, [id]));
    await db.delete(instruments).where(inArray(instruments.id, [id]));
    await close();
  });

  it('averages impact over good quotes and the gap over rows with a US price', async () => {
    await upsertInstruments(db, [
      {
        id,
        ticker,
        issuer: 'bstocks',
        platformId: 'bstock',
        chainId: 56,
        address: '0x00000000000000000000000000000000000000c1',
        symbol: `${ticker}B`,
        decimals: 18,
        assetType: 1,
        multiplier: '2',
        multiplierSource: 'onchain',
        apiShareRatio: '2',
        verifiedAt: '2031-01-01T00:00:00Z',
      },
    ]);
    const row = (slot: string, over: Record<string, unknown>) => ({
      sampledAt: slot,
      slotAt: slot,
      instrumentId: id,
      session: 'regular',
      sizeUsd: 5,
      tokenPrice: '202',
      stockPrice: '100',
      priceImpactPct: '0.10',
      ...over,
    });
    await insertTapeSamples(db, [
      row('2031-01-01T14:00:00Z', {}),
      row('2031-01-01T14:10:00Z', { priceImpactPct: '0.30', stockPrice: null }),
      row('2031-01-01T14:20:00Z', { errorCode: '40374', priceImpactPct: null }),
    ]);
    const mine = (await tapeSummary(db, new Date('2031-01-01T00:00:00Z'))).filter(
      (r) => r.issuer === 'bstocks' && r.quotes === 3,
    );
    expect(mine).toEqual([
      {
        session: 'regular',
        sizeUsd: 5,
        issuer: 'bstocks',
        quotes: 3,
        quoteErrors: 1,
        avgImpactPct: '0.2000',
        // (202 / 2) / 100 − 1 = +1 %
        avgGapPct: '1.0000',
        gapSamples: 2,
      },
    ]);
  });
});
