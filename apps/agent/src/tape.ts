/**
 * Market tape (TASKS M0-08, SPEC §10): every 10 minutes, per registered instrument, the on-chain
 * token price and reference price (RWA price), the independent US stock price (RWA Dynamic V2,
 * stock-price.ts), the market state (RWA list statusInfo plus our own US session tag) and one
 * Trading API quote per size ($5/$50/$500 USDT → token). Read-only: quotes are never swapped. A
 * failed quote or stock price is a row with its error, not a gap.
 */
import { BinanceApiError, type BinanceClient } from '@ijaro/binance';
import { BSC_CHAIN_ID, BSC_USDT } from '@ijaro/chain';
import { toUnits, usSession } from '@ijaro/core';
import type { InstrumentRow, TapeSampleInsert } from '@ijaro/db';
import { fetchRwaTokens, type RwaToken } from './registry.js';
import { fetchStockQuote, stockQuotesByTicker, type StockQuoteResult } from './stock-price.js';

export const TAPE_SIZES_USD = [5, 50, 500] as const;
export const TAPE_INTERVAL_MS = 10 * 60 * 1000;

interface RwaPrice {
  tokenContractAddress: string;
  tokenPrice: string | null;
  referencePrice: string | null;
  tokenPriceUpdatedAt: number | null;
}

export interface QuoteResult {
  quoteId?: string;
  isBest?: boolean;
  vendorName?: string;
  executionMode?: string;
  toTokenAmount?: string;
  priceImpactPercent?: string;
  dexRouterList?: { dexProtocol?: { dexName?: string; percent?: string } }[];
}

export interface QuoteOutcome {
  quote?: QuoteResult;
  errorCode?: string;
  errorMsg?: string;
  latencyMs: number | null;
}

/** GET /quote for `usd` USDT → token. `userWalletAddress` is required for RFQ routes (V-08). */
export async function quoteUsdtTo(
  client: BinanceClient,
  toToken: string,
  usd: number,
  userWalletAddress: string | undefined,
  options: { recordFixture?: boolean } = {},
): Promise<QuoteOutcome> {
  try {
    const res = await client.request<QuoteResult[]>('trading', 'getAggregatedQuote', {
      method: 'GET',
      path: '/api/v1/dex/aggregator/quote',
      query: {
        binanceChainId: String(BSC_CHAIN_ID),
        amount: toUnits(String(usd), 18).toString(),
        fromTokenAddress: BSC_USDT,
        toTokenAddress: toToken,
        ...(userWalletAddress ? { userWalletAddress } : {}),
      },
      recordFixture: options.recordFixture ?? false,
    });
    const best = res.data.find((q) => q.isBest) ?? res.data[0];
    return best
      ? { quote: best, latencyMs: res.latencyMs }
      : { errorCode: 'EMPTY', errorMsg: 'quote returned no routes', latencyMs: res.latencyMs };
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    return {
      errorCode: String(error.code ?? error.kind),
      errorMsg: error.msg,
      latencyMs: null,
    };
  }
}

export function routeOf(quote: QuoteResult | undefined): string | null {
  const hops = quote?.dexRouterList
    ?.map((r) => `${r.dexProtocol?.dexName ?? '?'} ${r.dexProtocol?.percent ?? '?'}%`)
    .join(' + ');
  return hops || null;
}

async function fetchRwaPrices(client: BinanceClient, addresses: string[]): Promise<RwaPrice[]> {
  const res = await client.request<RwaPrice[]>('rwa', 'getRwaTokenPrice', {
    method: 'GET',
    path: '/api/v1/dex/market/rwa/price',
    query: { binanceChainId: String(BSC_CHAIN_ID), tokenContractAddresses: addresses.join(',') },
  });
  return res.data;
}

export interface TapeDeps {
  client: BinanceClient;
  instruments: readonly InstrumentRow[];
  houseAddress: string | undefined;
  /** Idempotency key (see tapeSlot); defaults to the start time, i.e. a one-off run. */
  slotAt?: Date;
  now?: () => Date;
  /** Independent stock price source; defaults to the public RWA Dynamic V2 endpoint. */
  stockQuote?: (contractAddress: string) => Promise<StockQuoteResult>;
}

/** Start of the 10-minute wall-clock slot containing `at` — the scheduled run's idempotency key. */
export function tapeSlot(at: Date, intervalMs: number = TAPE_INTERVAL_MS): Date {
  return new Date(at.getTime() - (at.getTime() % intervalMs));
}

/** One tape run: returns the rows (caller inserts them). */
export async function sampleTape(deps: TapeDeps): Promise<TapeSampleInsert[]> {
  const sampledAt = (deps.now ?? (() => new Date()))();
  const slotAt = (deps.slotAt ?? sampledAt).toISOString();
  const session = usSession(sampledAt);
  const key = (a: string) => a.toLowerCase();
  let tokens: RwaToken[] = [];
  let prices: RwaPrice[] = [];
  let statusError: string | undefined;
  const stockQuotes = stockQuotesByTicker(
    deps.instruments,
    deps.stockQuote ?? ((address) => fetchStockQuote(address)),
  );
  try {
    [tokens, prices] = await Promise.all([
      fetchRwaTokens(deps.client),
      fetchRwaPrices(
        deps.client,
        deps.instruments.map((i) => i.address),
      ),
    ]);
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    statusError = `${error.code ?? error.kind}: ${error.msg}`;
  }
  const stockBy = await stockQuotes;
  const tokenBy = new Map(tokens.map((t) => [key(t.tokenContractAddress), t]));
  const priceBy = new Map(prices.map((p) => [key(p.tokenContractAddress), p]));

  const rows: TapeSampleInsert[] = [];
  for (const instrument of deps.instruments) {
    const status = tokenBy.get(key(instrument.address))?.statusInfo;
    const price = priceBy.get(key(instrument.address));
    const stock = stockBy.get(instrument.ticker);
    for (const sizeUsd of TAPE_SIZES_USD) {
      const outcome = await quoteUsdtTo(
        deps.client,
        instrument.address,
        sizeUsd,
        deps.houseAddress,
      );
      rows.push({
        sampledAt: sampledAt.toISOString(),
        slotAt,
        instrumentId: instrument.id,
        session,
        openState: status?.openState ?? null,
        marketStatus: status?.marketStatus ?? null,
        reasonCode: status?.reasonCode ?? (statusError ? 'UNAVAILABLE' : null),
        tokenPrice: price?.tokenPrice ?? null,
        referencePrice: price?.referencePrice ?? null,
        stockPrice: stock?.ok ? stock.stockPrice : null,
        stockPriceError: stock && !stock.ok ? stock.error : null,
        priceUpdatedAt: price?.tokenPriceUpdatedAt
          ? new Date(price.tokenPriceUpdatedAt).toISOString()
          : null,
        sizeUsd,
        expectedOut: outcome.quote?.toTokenAmount ?? null,
        priceImpactPct: outcome.quote?.priceImpactPercent ?? null,
        vendor: outcome.quote?.vendorName ?? null,
        executionMode: outcome.quote?.executionMode ?? null,
        route: routeOf(outcome.quote),
        errorCode: outcome.errorCode ?? null,
        errorMsg: outcome.errorMsg ?? null,
        latencyMs: outcome.latencyMs,
      });
    }
  }
  return rows;
}

/** Milliseconds until the next 10-minute wall-clock boundary. */
export function msUntilNextSlot(now: Date, intervalMs: number = TAPE_INTERVAL_MS): number {
  const t = now.getTime();
  return intervalMs - (t % intervalMs);
}
