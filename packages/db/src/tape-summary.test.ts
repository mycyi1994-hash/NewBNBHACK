/** Tape aggregates on Postgres: impact, errors and the price gap per session, size and issuer. */
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl as url } from '../test/helpers.js';
import {
  createDb,
  insertTapeSamples,
  instruments,
  tapeCoverage,
  tapeErrorCodes,
  tapeGapPercentiles,
  tapeSamples,
  tapeStatusCodes,
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

describe.skipIf(!url)('tape coverage, codes, statuses and gap percentiles on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const ticker = `P${randomUUID().slice(0, 6)}`;
  const ids = [`${ticker}:bstocks`, `${ticker}:ondo`];
  // A window of its own, so rows other tests write elsewhere in time never mix in.
  const day = 1 + Math.floor(Math.random() * 27);
  const at = (hhmm: string) => `2041-02-${String(day).padStart(2, '0')}T${hhmm}:00Z`;
  const since = new Date(at('00:00'));
  const until = new Date(at('23:59'));
  afterAll(async () => {
    await db.delete(tapeSamples).where(inArray(tapeSamples.instrumentId, ids));
    await db.delete(instruments).where(inArray(instruments.id, ids));
    await close();
  });

  it('counts runs, refusals, statuses and the gap distribution, one token-run at a time', async () => {
    const instrument = (issuer: 'bstocks' | 'ondo', multiplier: string) => ({
      id: `${ticker}:${issuer}`,
      ticker,
      issuer,
      platformId: issuer === 'bstocks' ? 'bstock' : 'ondo',
      chainId: 56,
      address: `0x00000000000000000000000000000000000000${issuer === 'bstocks' ? 'd1' : 'd2'}`,
      symbol: `${ticker}${issuer === 'bstocks' ? 'B' : 'on'}`,
      decimals: 18,
      assetType: 1,
      multiplier,
      multiplierSource: 'onchain',
      apiShareRatio: multiplier,
      verifiedAt: '2041-01-01T00:00:00Z',
    });
    await upsertInstruments(db, [instrument('bstocks', '1'), instrument('ondo', '2')]);
    // Three runs; each token is quoted at two sizes per run, which share one price.
    const run = (slot: string, session: string, bPrice: string, oPrice: string) =>
      [5, 50].flatMap((sizeUsd) => [
        {
          sampledAt: slot,
          slotAt: slot,
          instrumentId: ids[0] as string,
          session,
          sizeUsd,
          tokenPrice: bPrice,
          stockPrice: session === 'regular' ? '100' : null,
          reasonCode: 'TRADING',
          priceImpactPct: '0.05',
        },
        {
          sampledAt: slot,
          slotAt: slot,
          instrumentId: ids[1] as string,
          session,
          sizeUsd,
          tokenPrice: oPrice,
          stockPrice: session === 'regular' ? '100' : null,
          reasonCode: session === 'regular' ? 'TRADING' : 'MARKET_CLOSED',
          reasonMsg: session === 'regular' ? null : 'earnings',
          errorCode: sizeUsd === 5 ? '40375' : null,
          errorMsg: sizeUsd === 5 ? 'Minimum order amount is 5 USD.' : null,
        },
      ]);
    await insertTapeSamples(db, [
      // bStocks gaps +1 %, +3 %; Ondo (multiplier 2) gaps −1 %, +5 %.
      ...run(at('14:00'), 'regular', '101', '198'),
      ...run(at('14:10'), 'regular', '103', '210'),
      ...run(at('22:00'), 'overnight', '104', '200'),
    ]);

    expect(await tapeCoverage(db, since, until)).toEqual({
      runs: 3,
      rows: 12,
      tokens: 2,
      first: at('14:00'),
      last: at('22:00'),
      bySession: [
        { session: 'overnight', runs: 1 },
        { session: 'regular', runs: 2 },
      ],
    });
    expect(await tapeErrorCodes(db, since, until)).toEqual([
      {
        issuer: 'ondo',
        session: 'regular',
        code: '40375',
        count: 2,
        message: 'Minimum order amount is 5 USD.',
      },
      {
        issuer: 'ondo',
        session: 'overnight',
        code: '40375',
        count: 1,
        message: 'Minimum order amount is 5 USD.',
      },
    ]);
    expect(await tapeStatusCodes(db, since, until)).toEqual([
      { issuer: 'bstocks', reasonCode: 'TRADING', reasonMsg: null, tokenRuns: 3 },
      { issuer: 'ondo', reasonCode: 'TRADING', reasonMsg: null, tokenRuns: 2 },
      { issuer: 'ondo', reasonCode: 'MARKET_CLOSED', reasonMsg: 'earnings', tokenRuns: 1 },
    ]);
    expect(await tapeGapPercentiles(db, since, until)).toEqual([
      // Two token-runs each (the second size does not count twice); off-hours had no US price.
      // p90 of |gap| interpolates: bStocks 1 + 0.9 × (3 − 1) = 2.8; Ondo 1 + 0.9 × (5 − 1) = 4.6.
      {
        issuer: 'bstocks',
        session: 'regular',
        samples: 2,
        medianGapPct: '2.0000',
        p90AbsGapPct: '2.8000',
      },
      {
        issuer: 'ondo',
        session: 'regular',
        samples: 2,
        medianGapPct: '2.0000',
        p90AbsGapPct: '4.6000',
      },
    ]);
  });
});
