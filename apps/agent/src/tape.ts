/**
 * Market tape (TASKS M0-08, SPEC §10): every 10 minutes, per registered instrument, the on-chain
 * token price and reference price (RWA price), the market state (RWA list statusInfo plus our own
 * US session tag) and one Trading API quote per size ($5/$50/$500 USDT → token). Read-only: quotes
 * are never swapped. A failed quote is a row with its error code, not a gap.
 */
import { BinanceApiError, type BinanceClient } from '@ijaro/binance';
import { BSC_CHAIN_ID, BSC_USDT } from '@ijaro/chain';
import { toUnits, usSession } from '@ijaro/core';
import type { InstrumentRow, TapeSampleInsert } from '@ijaro/db';
import { fetchRwaTokens, type RwaToken } from './registry.js';

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
  now?: () => Date;
}

/** One tape run: returns the rows (caller inserts them). */
export async function sampleTape(deps: TapeDeps): Promise<TapeSampleInsert[]> {
  const sampledAt = (deps.now ?? (() => new Date()))();
  const session = usSession(sampledAt);
  const key = (a: string) => a.toLowerCase();
  let tokens: RwaToken[] = [];
  let prices: RwaPrice[] = [];
  let statusError: string | undefined;
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
  const tokenBy = new Map(tokens.map((t) => [key(t.tokenContractAddress), t]));
  const priceBy = new Map(prices.map((p) => [key(p.tokenContractAddress), p]));

  const rows: TapeSampleInsert[] = [];
  for (const instrument of deps.instruments) {
    const status = tokenBy.get(key(instrument.address))?.statusInfo;
    const price = priceBy.get(key(instrument.address));
    for (const sizeUsd of TAPE_SIZES_USD) {
      const outcome = await quoteUsdtTo(
        deps.client,
        instrument.address,
        sizeUsd,
        deps.houseAddress,
      );
      rows.push({
        sampledAt: sampledAt.toISOString(),
        instrumentId: instrument.id,
        session,
        openState: status?.openState ?? null,
        marketStatus: status?.marketStatus ?? null,
        reasonCode: status?.reasonCode ?? (statusError ? 'UNAVAILABLE' : null),
        tokenPrice: price?.tokenPrice ?? null,
        referencePrice: price?.referencePrice ?? null,
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
