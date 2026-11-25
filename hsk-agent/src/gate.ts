// Gate spot candles (public, CORS open). Used for the DEX chart (HSKSwap has too few swaps for candles)
// and for the strategy backtests. Row: [time s, quote volume, close, high, low, open, base volume, closed].
import type { Asset } from './intent.ts';
import type { Candle } from './cex.ts';

export const GATE_PAIR: Record<Asset, string> = { HSK: 'HSK_USDT', ETH: 'ETH_USDT', BTC: 'BTC_USDT' };
export type GateInterval = '15m' | '1h' | '4h' | '1d' | '7d';
export const GATE_SECONDS: Record<GateInterval, number> = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '7d': 604800 };

/** Oldest first. With `to` (seconds), returns the `limit` bars ending there (Gate rejects limit together with from/to). */
export async function gateCandles(asset: Asset, interval: GateInterval, limit = 500, to?: number): Promise<Candle[]> {
  const q = to
    ? `from=${to - limit * GATE_SECONDS[interval]}&to=${to}`
    : `limit=${limit}`;
  const r = await fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${GATE_PAIR[asset]}&interval=${interval}&${q}`);
  if (!r.ok) throw new Error(`Gate HTTP ${r.status}`);
  const rows = (await r.json()) as string[][];
  return rows
    .map((x) => ({ time: Number(x[0]), close: +x[2], high: +x[3], low: +x[4], open: +x[5], volume: +x[6] }))
    .filter((c) => c.close > 0);
}
