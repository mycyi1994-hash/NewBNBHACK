/**
 * GET /api/projection and the MCP tool (DECISIONS D-31, F3): the interest calculator's inputs as
 * the worker recorded them — the listed Venus APY with its age, the minimum buy, a share price
 * from the latest tape — and the projection lib/projection.ts makes of them. Each input carries
 * its data state; without a rate there is no projection, never a guessed one.
 */
import type { Issuer } from '@yieldvest/core';
import { instrumentFromRow, listInstruments, type Db } from '@yieldvest/db';
import { projectInterest, type Projection } from '../projection';
import { VENUS_FRESH_MS, venusInfo, type VenusInfo } from './house';
import { marketsFromTape, tapeView } from './market';

export type State = 'LIVE' | 'STALE' | 'UNAVAILABLE';

export interface ProjectionView {
  depositUsd: string;
  /** The listed APY in percent, as the DeFi API displayed it, and when the worker read it. */
  apy: { pct: string | null; at: string | null; state: State };
  minBuyUsd: string;
  price: {
    ticker: string;
    issuer: Issuer;
    sharePriceUsd: string | null;
    sampledAt: string | null;
    state: State;
  } | null;
  /** Null without a usable rate. */
  projection: Projection | null;
  /** What the numbers assume, in words a program can match on. */
  assumption: 'listed_apy_held_constant_compounded_daily';
}

const ISSUER_ORDER: readonly Issuer[] = ['bstocks', 'ondo', 'xstocks'];

/** The listed APY with its data state: LIVE within VENUS_FRESH_MS of the worker's read. */
export function apyView(venus: VenusInfo, now: Date): ProjectionView['apy'] {
  const state: State =
    venus.apy === null
      ? 'UNAVAILABLE'
      : venus.apyAt !== null && now.getTime() - Date.parse(venus.apyAt) <= VENUS_FRESH_MS
        ? 'LIVE'
        : 'STALE';
  return { pct: venus.apy, at: venus.apyAt, state };
}

export async function interestProjection(
  db: Db,
  query: { depositUsd: string; ticker?: string; issuer?: Issuer },
  minBuyUsd: string,
  now = new Date(),
): Promise<ProjectionView> {
  const venus = await venusInfo(db, now);

  let price: ProjectionView['price'] = null;
  if (query.ticker) {
    const instruments = (await listInstruments(db))
      .filter((i) => i.ticker === query.ticker)
      .filter((i) => query.issuer === undefined || i.issuer === query.issuer)
      .map(instrumentFromRow)
      .sort((a, b) => ISSUER_ORDER.indexOf(a.issuer) - ISSUER_ORDER.indexOf(b.issuer));
    const tape = await tapeView(db, now);
    const markets = marketsFromTape(instruments, tape.rows);
    // The first issuer (in the order asked) that has a price; else the first, without one.
    const market = markets.find((m) => m.onchainSharePriceUsd !== null) ?? markets[0];
    if (market) {
      price = {
        ticker: market.instrument.ticker,
        issuer: market.instrument.issuer,
        sharePriceUsd: market.onchainSharePriceUsd,
        sampledAt: tape.sampledAt,
        state: market.onchainSharePriceUsd === null ? 'UNAVAILABLE' : tape.state,
      };
    }
  }

  const projection =
    venus.apy === null
      ? null
      : projectInterest({
          depositUsd: Number(query.depositUsd),
          apyPct: Number(venus.apy.replaceAll(',', '')),
          minBuyUsd: Number(minBuyUsd),
          sharePriceUsd: price?.sharePriceUsd ? Number(price.sharePriceUsd) : null,
        });

  return {
    depositUsd: query.depositUsd,
    apy: apyView(venus, now),
    minBuyUsd,
    price,
    projection,
    assumption: 'listed_apy_held_constant_compounded_daily',
  };
}
