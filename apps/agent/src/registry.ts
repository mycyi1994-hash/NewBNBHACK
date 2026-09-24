/**
 * Instrument registry (TASKS M0-05, DECISIONS D-07): the RWA Data token list is the only source of
 * stock token addresses. Every candidate is checked on-chain (symbol, decimals; bStocks also
 * uiMultiplier against the API's tokenToShareRatio) before it is written to `instruments`.
 */
import type { BinanceClient } from '@ijaro/binance';
import { BSC_CHAIN_ID, readBstockMultiplier, readErc20Meta, type BscClient } from '@ijaro/chain';
import { fromUnits } from '@ijaro/core';
import type { InstrumentRow } from '@ijaro/db';

/** Candidate tickers (PLAN/TASKS M0-05). Tickers are product choices; addresses are not in code. */
export const CANDIDATE_TICKERS = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'QQQ'] as const;

/** RWA list `platformId` → SPEC §4 `Issuer`. */
export const ISSUER_BY_PLATFORM: Readonly<Record<string, string>> = {
  bstock: 'bstocks',
  ondo: 'ondo',
  xstocks: 'xstocks',
};

export interface RwaStatusInfo {
  openState?: boolean | null;
  marketStatus?: string | null;
  reasonCode?: string | null;
  reasonMsg?: string | null;
  nextOpenTime?: number | null;
  nextCloseTime?: number | null;
}

export interface RwaToken {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId: string;
  assetType: number | null;
  tokenSymbol: string;
  decimals: string;
  underlyingTicker: string;
  tokenToShareRatio: string | null;
  statusInfo?: RwaStatusInfo | null;
  tokenPrice?: string | null;
  referencePrice?: string | null;
}

export async function fetchRwaTokens(
  client: BinanceClient,
  options: { recordFixture?: boolean } = {},
): Promise<RwaToken[]> {
  const res = await client.request<RwaToken[]>('rwa', 'getRwaTokenList', {
    method: 'GET',
    path: '/api/v1/dex/market/rwa/tokens',
    query: { binanceChainId: String(BSC_CHAIN_ID) },
    recordFixture: options.recordFixture ?? false,
  });
  return res.data;
}

export interface Verification {
  token: RwaToken;
  row?: InstrumentRow;
  /** Human-readable on-chain check results, or the reason the token was rejected. */
  checks: string[];
  ok: boolean;
}

/** Compares a 1e18-scaled on-chain value with an API decimal string, exactly. */
function sameRatio(onchain: bigint, api: string | null): boolean {
  if (api === null) return false;
  const trimmed = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return trimmed(fromUnits(onchain, 18)) === trimmed(api);
}

export async function verifyToken(
  bsc: BscClient,
  token: RwaToken,
  now: Date,
): Promise<Verification> {
  const issuer = ISSUER_BY_PLATFORM[token.platformId];
  if (!issuer) return { token, checks: [`unknown platformId ${token.platformId}`], ok: false };
  const meta = await readErc20Meta(bsc, token.tokenContractAddress);
  const checks = [
    `symbol ${meta.symbol} ${meta.symbol === token.tokenSymbol ? '=' : '≠'} API ${token.tokenSymbol}`,
    `decimals ${meta.decimals} ${String(meta.decimals) === token.decimals ? '=' : '≠'} API ${token.decimals}`,
  ];
  let ok = meta.symbol === token.tokenSymbol && String(meta.decimals) === token.decimals;
  let multiplier = token.tokenToShareRatio ?? '1';
  let multiplierSource = 'api:tokenToShareRatio';
  if (token.platformId === 'bstock') {
    const m = await readBstockMultiplier(bsc, token.tokenContractAddress);
    multiplier = fromUnits(m.uiMultiplier, 18);
    multiplierSource = 'onchain:uiMultiplier';
    const agrees = sameRatio(m.uiMultiplier, token.tokenToShareRatio);
    checks.push(
      `uiMultiplier ${multiplier} ${agrees ? '=' : '≠'} API tokenToShareRatio ${token.tokenToShareRatio}` +
        (m.effectiveAt > 0n
          ? ` (newUIMultiplier ${fromUnits(m.newUIMultiplier, 18)} at ${m.effectiveAt})`
          : ''),
    );
    ok &&= agrees;
  }
  const row: InstrumentRow = {
    id: `${token.underlyingTicker}:${issuer}`,
    ticker: token.underlyingTicker,
    issuer,
    platformId: token.platformId,
    chainId: BSC_CHAIN_ID,
    address: meta.address,
    symbol: meta.symbol,
    decimals: meta.decimals,
    assetType: token.assetType,
    multiplier,
    multiplierSource,
    apiShareRatio: token.tokenToShareRatio,
    verifiedAt: now.toISOString(),
  };
  return { token, row, checks, ok };
}

/** ticker → issuer → present? — the matrix for DECISIONS M0-05. */
export function presenceMatrix(
  tokens: readonly RwaToken[],
  tickers: readonly string[],
): Map<string, Map<string, string[]>> {
  const matrix = new Map<string, Map<string, string[]>>();
  for (const ticker of tickers) matrix.set(ticker, new Map());
  for (const t of tokens) {
    const row = matrix.get(t.underlyingTicker);
    if (!row) continue;
    const issuer = ISSUER_BY_PLATFORM[t.platformId] ?? t.platformId;
    row.set(issuer, [...(row.get(issuer) ?? []), t.tokenSymbol]);
  }
  return matrix;
}
