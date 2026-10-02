/**
 * bStocks against Ondo for one US stock (DECISIONS D-31, feature F2): the same share from two
 * issuers side by side, from the worker's latest tape run — the shares each $5 / $50 / $500 quote
 * was worth, what one share cost in it, its price impact or the code it was refused with, each
 * token's status and each venue's minimum order. Facts with their time, never a pick: the Wallet
 * Skill still asks the user which token to buy (skills/yieldvest/references/plan.md).
 */
import {
  formatShares,
  fromUnits,
  sharesFromTokens,
  toUnits,
  type Instrument,
  type Issuer,
} from '@yieldvest/core';
import { instrumentFromRow, listInstruments, type Db, type TapeSampleRow } from '@yieldvest/db';
import { gapPctText, marketsFromTape, tapeView, type TapeView } from './market';

export interface SizeQuote {
  sizeUsd: number;
  /** Underlying shares the quoted tokens are worth (tokens × multiplier), at most 6 decimals. */
  shares: string | null;
  /** sizeUsd ÷ shares: what one share cost in this quote, price impact included. */
  usdPerShare: string | null;
  priceImpactPct: string | null;
  /** The Trading API code the quote was refused with (40375 under the minimum, …). */
  errorCode: string | null;
  errorMsg: string | null;
}

export interface IssuerSide {
  issuer: Issuer;
  symbol: string;
  address: string;
  multiplier: string;
  status: { openState: boolean | null; reasonCode: string; reasonMsg: string | null };
  onchainSharePriceUsd: string | null;
  stockPriceUsd: string | null;
  gapPct: string | null;
  venueMinUsd: string | null;
  quotes: SizeQuote[];
}

/** Per quote size: which issuer's quote was worth more shares, and by how much (percent). */
export interface SizeVerdict {
  sizeUsd: number;
  moreShares: Issuer | null;
  byPct: string | null;
}

export interface Comparison {
  ticker: string;
  data: Pick<TapeView, 'state' | 'sampledAt' | 'ageSeconds'>;
  issuers: IssuerSide[];
  sizes: SizeVerdict[];
}

const E18 = 10n ** 18n;

/** Share units (18 decimals) of a recorded quote, or null when it has no amount. */
function shareUnits(row: TapeSampleRow, instrument: Instrument): bigint | null {
  if (row.errorCode || !row.expectedOut || !/^\d+$/.test(row.expectedOut)) return null;
  const shares = sharesFromTokens(
    BigInt(row.expectedOut),
    instrument.decimals,
    instrument.multiplier,
  );
  const units = toUnits(shares, 18);
  return units > 0n ? units : null;
}

/** USD per share to four decimals, rounded down. */
function perShare(sizeUsd: number, units: bigint): string {
  const price = (toUnits(String(sizeUsd), 18) * E18) / units;
  const four = price - (price % 10n ** 14n);
  return fromUnits(four, 18);
}

/** The comparison for `ticker` from one tape run; pure, so every branch is a unit test. */
export function compareFromTape(
  ticker: string,
  instruments: readonly Instrument[],
  tape: Pick<TapeView, 'state' | 'sampledAt' | 'ageSeconds' | 'rows'>,
): Comparison {
  const own = instruments.filter((i) => i.ticker === ticker);
  const markets = marketsFromTape(own, tape.rows);
  const units = new Map<string, Map<number, bigint | null>>();
  const issuers: IssuerSide[] = markets.map((market) => {
    const { instrument, status } = market;
    const rows = tape.rows
      .filter((r) => r.instrumentId === instrument.id)
      .sort((a, b) => a.sizeUsd - b.sizeUsd);
    const bySize = new Map<number, bigint | null>();
    const quotes = rows.map((row): SizeQuote => {
      const shares = shareUnits(row, instrument);
      bySize.set(row.sizeUsd, shares);
      return {
        sizeUsd: row.sizeUsd,
        shares: shares === null ? null : formatShares(shares),
        usdPerShare: shares === null ? null : perShare(row.sizeUsd, shares),
        priceImpactPct: row.errorCode ? null : row.priceImpactPct,
        errorCode: row.errorCode,
        errorMsg: row.errorMsg,
      };
    });
    units.set(instrument.issuer, bySize);
    return {
      issuer: instrument.issuer,
      symbol: instrument.symbol,
      address: instrument.address,
      multiplier: instrument.multiplier,
      status: {
        openState: status.openState,
        reasonCode: status.reasonCode ?? 'UNAVAILABLE',
        reasonMsg: status.reasonMsg,
      },
      onchainSharePriceUsd: market.onchainSharePriceUsd,
      stockPriceUsd: market.independentSharePriceUsd,
      gapPct: gapPctText(market.onchainSharePriceUsd, market.independentSharePriceUsd),
      venueMinUsd: market.venueMinUsd,
      quotes,
    };
  });

  const sizeList = [...new Set(issuers.flatMap((s) => s.quotes.map((q) => q.sizeUsd)))].sort(
    (a, b) => a - b,
  );
  const sizes = sizeList.map((sizeUsd): SizeVerdict => {
    const priced = issuers
      .map((side) => ({ issuer: side.issuer, units: units.get(side.issuer)?.get(sizeUsd) ?? null }))
      .filter((p): p is { issuer: Issuer; units: bigint } => p.units !== null)
      .sort((a, b) => (a.units === b.units ? 0 : a.units > b.units ? -1 : 1));
    const [first, second] = priced;
    // Only a real comparison names an issuer: two quotes, and not the same number of shares.
    if (!first || !second || first.units === second.units) {
      return { sizeUsd, moreShares: null, byPct: null };
    }
    // (first ÷ second − 1) × 100, in percent with four decimals, rounded down.
    const pctE4 = ((first.units - second.units) * 1_000_000n) / second.units;
    return { sizeUsd, moreShares: first.issuer, byPct: fromUnits(pctE4, 4) };
  });

  return {
    ticker,
    data: { state: tape.state, sampledAt: tape.sampledAt, ageSeconds: tape.ageSeconds },
    issuers,
    sizes,
  };
}

/** Tickers in the registry, each with the issuers that sell it (the comparison page's chooser). */
export async function comparableTickers(db: Db): Promise<{ ticker: string; issuers: Issuer[] }[]> {
  const registry = (await listInstruments(db)).map(instrumentFromRow);
  const out = new Map<string, Issuer[]>();
  for (const i of registry) out.set(i.ticker, [...(out.get(i.ticker) ?? []), i.issuer]);
  return [...out.entries()]
    .map(([ticker, issuers]) => ({ ticker, issuers: issuers.sort() }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** GET /api/compare and the /compare page: undefined when the ticker is not in the registry. */
export async function compareIssuers(
  db: Db,
  ticker: string,
  now = new Date(),
): Promise<Comparison | undefined> {
  const instruments = (await listInstruments(db))
    .filter((i) => i.ticker === ticker)
    .map(instrumentFromRow);
  if (instruments.length === 0) return undefined;
  return compareFromTape(ticker, instruments, await tapeView(db, now));
}
