/**
 * What decideCycle needs to know about the market this tick (SPEC §5.2–§5.6): the registry rows
 * for the plan's ticker, their RWA status, the on-chain price per share, the independent US price
 * (RWA Dynamic V2, may be null off-hours) and each venue's minimum; plus one quote at a time.
 * A source that fails leaves its field empty (UNAVAILABLE), never a guessed value.
 */
import {
  BinanceApiError,
  getQuote,
  getRwaPrices,
  type BinanceClient,
  type QuoteRoute,
} from '@ijaro/binance';
import { BSC_USDT } from '@ijaro/chain';
import { toUnits, type InstrumentMarket, type Issuer, type QuoteObservation } from '@ijaro/core';
import { instrumentFromRow, listInstruments, type Db } from '@ijaro/db';
import { fetchRwaTokens, type RwaToken } from './registry.js';
import { fetchStockQuote, type StockQuoteResult } from './stock-price.js';

/**
 * Smallest order each venue accepts, USD. Ondo rejects exactly $5.00 and accepts $5.01 (measured,
 * DECISIONS Q-03); bStocks quoted $0.10 without complaint. A larger minimum seen later in a 40375
 * message rules the venue out for that cycle (decideCycle).
 */
export const VENUE_MIN_USD: Readonly<Record<Issuer, string | null>> = {
  bstocks: null,
  ondo: '5.01',
  xstocks: null,
};

export interface MarketDeps {
  client: BinanceClient;
  db: Db;
  stockQuote?: (contractAddress: string) => Promise<StockQuoteResult>;
  log?: (line: string) => void;
}

export interface MarketSnapshot {
  markets: InstrumentMarket[];
  /** Sources that failed this tick, for the step log. */
  unavailable: string[];
}

function sharePrice(tokenPrice: string | null | undefined, multiplier: string): string | null {
  if (!tokenPrice) return null;
  const price = Number(tokenPrice) / Number(multiplier);
  return Number.isFinite(price) && price > 0 ? price.toFixed(6) : null;
}

export async function marketSnapshot(deps: MarketDeps, ticker: string): Promise<MarketSnapshot> {
  const instruments = (await listInstruments(deps.db))
    .filter((row) => row.ticker === ticker)
    .map(instrumentFromRow);
  const unavailable: string[] = [];
  const key = (address: string) => address.toLowerCase();

  let tokens: RwaToken[] = [];
  let prices: Awaited<ReturnType<typeof getRwaPrices>> = [];
  try {
    tokens = await fetchRwaTokens(deps.client);
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    unavailable.push(`rwa status: ${error.code ?? error.kind} ${error.msg}`);
  }
  if (instruments.length > 0) {
    try {
      prices = await getRwaPrices(
        deps.client,
        instruments.map((i) => i.address),
      );
    } catch (error) {
      if (!(error instanceof BinanceApiError)) throw error;
      unavailable.push(`rwa price: ${error.code ?? error.kind} ${error.msg}`);
    }
  }
  const [first] = instruments;
  const stock = first ? await (deps.stockQuote ?? fetchStockQuote)(first.address) : undefined;
  if (stock && !stock.ok) unavailable.push(`stock price: ${stock.error}`);

  const tokenBy = new Map(tokens.map((t) => [key(t.tokenContractAddress), t]));
  const priceBy = new Map(prices.map((p) => [key(p.tokenContractAddress), p]));
  const markets = instruments.map((instrument): InstrumentMarket => {
    const status = tokenBy.get(key(instrument.address))?.statusInfo;
    return {
      instrument,
      status: {
        openState: status?.openState ?? null,
        reasonCode: status?.reasonCode ?? (tokens.length === 0 ? 'UNAVAILABLE' : null),
        reasonMsg: status?.reasonMsg ?? null,
        nextOpenTime: status?.nextOpenTime ?? null,
      },
      onchainSharePriceUsd: sharePrice(
        priceBy.get(key(instrument.address))?.tokenPrice,
        instrument.multiplier,
      ),
      independentSharePriceUsd: stock?.ok ? stock.stockPrice : null,
      venueMinUsd: VENUE_MIN_USD[instrument.issuer],
    };
  });
  return { markets, unavailable };
}

/**
 * One quote for `spendUsd` USDT → the instrument, as decideCycle reads it. A failed quote is an
 * observation with its code and the taxonomy's verdict (next issuer, market closed), not an error.
 */
export async function observeQuote(
  deps: { client: BinanceClient; house: string; now: () => Date },
  market: InstrumentMarket,
  spendUsd: string,
): Promise<{ observation: QuoteObservation; route?: QuoteRoute }> {
  const base = { instrumentId: market.instrument.id, spendUsd };
  try {
    const { routes } = await getQuote(deps.client, {
      fromToken: BSC_USDT,
      toToken: market.instrument.address,
      amount: toUnits(spendUsd, 18),
      userWalletAddress: deps.house,
    });
    const receivedAt = deps.now().toISOString();
    const [best] = routes;
    if (!best) {
      return {
        observation: {
          ...base,
          receivedAt,
          errorCode: 'EMPTY',
          errorMsg: 'quote returned no routes',
        },
      };
    }
    return {
      observation: {
        ...base,
        receivedAt,
        quoteId: best.quoteId,
        ...(best.toTokenAmount ? { toTokenAmount: best.toTokenAmount } : {}),
        ...(best.priceImpactPercent ? { priceImpactPct: best.priceImpactPercent } : {}),
        ...(best.executionMode ? { executionMode: best.executionMode } : {}),
      },
      route: best,
    };
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    const { action } = error.classify();
    return {
      observation: {
        ...base,
        receivedAt: deps.now().toISOString(),
        errorCode: String(error.code ?? error.kind),
        errorMsg: error.msg,
        ...(action === 'next_issuer' || action === 'market_closed' ? { errorAction: action } : {}),
      },
    };
  }
}
