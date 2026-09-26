/**
 * GET /api/market/status — the US session by our NYSE calendar and each registered token's last
 * recorded state (tape), with the data state (LIVE / STALE / UNAVAILABLE).
 */
import { nextRegularOpen, OPEN_SETTLE_MS, usSession } from '@ijaro/core';
import { instrumentFromRow, listInstruments } from '@ijaro/db';
import { context } from '../../../../lib/server/context';
import { json, unavailable } from '../../../../lib/server/http';
import { gapPctText, marketsFromTape, tapeView } from '../../../../lib/server/market';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const now = new Date();
  const tape = await tapeView(db, now);
  const instruments = (await listInstruments(db)).map(instrumentFromRow);
  const markets = marketsFromTape(instruments, tape.rows);
  return json({
    at: now.toISOString(),
    session: usSession(now),
    nextRegularOpen: nextRegularOpen(now).toISOString(),
    nextBuyWindow: new Date(nextRegularOpen(now).getTime() + OPEN_SETTLE_MS).toISOString(),
    data: { state: tape.state, sampledAt: tape.sampledAt, ageSeconds: tape.ageSeconds },
    instruments: markets.map((m) => ({
      id: m.instrument.id,
      ticker: m.instrument.ticker,
      issuer: m.instrument.issuer,
      symbol: m.instrument.symbol,
      reasonCode: m.status.reasonCode,
      reasonMsg: m.status.reasonMsg,
      onchainSharePriceUsd: m.onchainSharePriceUsd,
      stockPriceUsd: m.independentSharePriceUsd,
      gapPct: gapPctText(m.onchainSharePriceUsd, m.independentSharePriceUsd),
      venueMinUsd: m.venueMinUsd,
    })),
  });
}
