/**
 * Market data for decisions and screens, taken from the worker's latest tape run (SPEC §10) —
 * never a live API call from the web. Every view carries its data state (CLAUDE.md rule 4): LIVE,
 * STALE with its time, or UNAVAILABLE with a reason.
 */
import {
  nextRegularOpen,
  OPEN_SETTLE_MS,
  regularClose,
  toUnits,
  usSession,
  VENUE_MIN_USD,
  type Instrument,
  type InstrumentMarket,
  type QuoteObservation,
} from '@yieldvest/core';
import {
  instrumentFromRow,
  isoTime,
  latestTapeSamples,
  listInstruments,
  type Db,
  type TapeSampleRow,
} from '@yieldvest/db';

/**
 * Two tape intervals (10 min each, M0-08): one missed run is still LIVE, two are STALE. Older than
 * this, a decision waits instead of trusting the numbers.
 */
export const TAPE_FRESH_MS = 2 * 10 * 60_000;

export interface TapeView {
  state: 'LIVE' | 'STALE' | 'UNAVAILABLE';
  sampledAt: string | null;
  slotAt: string | null;
  ageSeconds: number | null;
  rows: TapeSampleRow[];
}

export async function tapeView(db: Db, now: Date): Promise<TapeView> {
  const rows = await latestTapeSamples(db);
  const first = rows[0];
  if (!first)
    return { state: 'UNAVAILABLE', sampledAt: null, slotAt: null, ageSeconds: null, rows };
  const sampledAt = isoTime(first.sampledAt);
  const ageMs = now.getTime() - Date.parse(sampledAt);
  return {
    state: ageMs <= TAPE_FRESH_MS ? 'LIVE' : 'STALE',
    sampledAt,
    slotAt: isoTime(first.slotAt),
    ageSeconds: Math.round(ageMs / 1000),
    rows,
  };
}

function sharePrice(tokenPrice: string | null, multiplier: string): string | null {
  if (!tokenPrice) return null;
  const price = Number(tokenPrice) / Number(multiplier);
  return Number.isFinite(price) && price > 0 ? price.toFixed(6) : null;
}

/** On-chain share price against the US price, in percent with two decimals; never "-0.00". */
export function gapPctText(sharePrice: string | null, usPrice: string | null): string | null {
  if (!sharePrice || !usPrice) return null;
  const gap = (Number(sharePrice) / Number(usPrice) - 1) * 100;
  if (!Number.isFinite(gap)) return null;
  const text = gap.toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

/** decideCycle's market input for the given instruments, from one tape run. */
export function marketsFromTape(
  instruments: readonly Instrument[],
  rows: readonly TapeSampleRow[],
): InstrumentMarket[] {
  return instruments.map((instrument) => {
    const row = rows.find((r) => r.instrumentId === instrument.id);
    return {
      instrument,
      status: {
        openState: row?.openState ?? null,
        reasonCode: row?.reasonCode ?? 'UNAVAILABLE',
        reasonMsg: row?.reasonMsg ?? null,
        nextOpenTime: row?.nextOpenTime ?? null,
      },
      onchainSharePriceUsd: sharePrice(row?.tokenPrice ?? null, instrument.multiplier),
      independentSharePriceUsd: row?.stockPrice ?? null,
      venueMinUsd: VENUE_MIN_USD[instrument.issuer],
    };
  });
}

/**
 * A planning estimate from the tape for `spendUsd`: the tape quote of the smallest recorded size
 * at or above the spend, scaled to it, with that size's price impact and error code. It is never
 * executed — the user's wallet quotes again before it swaps — so it is dated `now` and named
 * `tape-estimate`.
 */
export function estimateQuote(
  rows: readonly TapeSampleRow[],
  instrumentId: string,
  spendUsd: string,
  now: Date,
): QuoteObservation {
  const spend = toUnits(spendUsd, 18);
  const candidates = rows
    .filter((r) => r.instrumentId === instrumentId)
    .sort((a, b) => a.sizeUsd - b.sizeUsd);
  const row = candidates.find((r) => toUnits(String(r.sizeUsd), 18) >= spend) ?? candidates.at(-1);
  const base = { instrumentId, spendUsd, receivedAt: now.toISOString() };
  if (!row) return { ...base, errorCode: 'NO_TAPE', errorMsg: 'no tape quote for this instrument' };
  if (row.errorCode) {
    return { ...base, errorCode: row.errorCode, errorMsg: row.errorMsg ?? 'recorded quote error' };
  }
  if (!row.expectedOut)
    return { ...base, errorCode: 'NO_TAPE', errorMsg: 'tape quote has no amount' };
  const scaled = (BigInt(row.expectedOut) * spend) / toUnits(String(row.sizeUsd), 18);
  return {
    ...base,
    quoteId: 'tape-estimate',
    toTokenAmount: scaled.toString(),
    ...(row.priceImpactPct ? { priceImpactPct: row.priceImpactPct } : {}),
    ...(row.executionMode ? { executionMode: row.executionMode } : {}),
  };
}

/**
 * The US session by our NYSE calendar and each registered token's last recorded state (Watch
 * screen, Judge Mode, GET /api/market/status), with the tape's data state.
 */
export async function marketStatus(db: Db, now = new Date()) {
  const tape = await tapeView(db, now);
  const instruments = (await listInstruments(db)).map(instrumentFromRow);
  const markets = marketsFromTape(instruments, tape.rows);
  const open = nextRegularOpen(now);
  return {
    at: now.toISOString(),
    session: usSession(now),
    regularClose: regularClose(now)?.toISOString() ?? null,
    nextRegularOpen: open.toISOString(),
    nextBuyWindow: new Date(open.getTime() + OPEN_SETTLE_MS).toISOString(),
    data: { state: tape.state, sampledAt: tape.sampledAt, ageSeconds: tape.ageSeconds },
    instruments: markets.map((m) => ({
      id: m.instrument.id,
      ticker: m.instrument.ticker,
      issuer: m.instrument.issuer,
      symbol: m.instrument.symbol,
      address: m.instrument.address,
      multiplier: m.instrument.multiplier,
      reasonCode: m.status.reasonCode,
      reasonMsg: m.status.reasonMsg,
      onchainSharePriceUsd: m.onchainSharePriceUsd,
      stockPriceUsd: m.independentSharePriceUsd,
      gapPct: gapPctText(m.onchainSharePriceUsd, m.independentSharePriceUsd),
      venueMinUsd: m.venueMinUsd,
    })),
  };
}

export type MarketStatus = Awaited<ReturnType<typeof marketStatus>>;
