// HashKey Global public market data (no API key): the two USDT perpetuals and the USDT spot pairs.
// Futures quantities are in contracts; 1 contract = 0.001 of the coin (exchangeInfo contractMultiplier).

const BASE = 'https://api-glb.hashkey.com';

export interface Market { symbol: string; base: string; kind: 'perp' | 'spot'; mult: number }
const perp = (base: string): Market => ({ symbol: `${base}USDT-PERPETUAL`, base, kind: 'perp', mult: 0.001 });
const spot = (base: string): Market => ({ symbol: `${base}USDT`, base, kind: 'spot', mult: 1 });
/** Perpetuals listed on HashKey Global (exchangeInfo.contracts), then the liquid USDT spot pairs. */
export const MARKETS: Market[] = [
  perp('BTC'), perp('ETH'),
  ...['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'SUI', 'AVAX', 'LINK', 'TRX', 'HSK'].map(spot),
];
export const DEFAULT_MARKET = MARKETS[0];
export const marketBySymbol = (s: string) => MARKETS.find((m) => m.symbol === s) ?? DEFAULT_MARKET;

export interface Ticker { last: number; open: number; high: number; low: number; volBase: number; volUsdt: number; bid: number; ask: number; at: number }
export interface Level { price: number; qty: number }
export interface Trade { t: number; price: number; qty: number; buyerIsMaker: boolean }
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export type Interval = '1m' | '15m' | '1h' | '4h' | '1d' | '1w';

/** Same-origin proxy first (vite dev/preview), then the public API directly (static hosting). */
const SOURCES = typeof window === 'undefined' ? [BASE] : ['./hk', BASE];
let working: string | undefined;

async function get<T>(path: string): Promise<T> {
  let last: unknown;
  for (const base of working ? [working] : SOURCES) {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(8000) });
      if (!(r.headers.get('content-type') ?? '').includes('json') && r.ok) throw new Error('not JSON (no proxy here)');
      if (!r.ok) throw new Error(`HashKey Global HTTP ${r.status}`);
      const j = (await r.json()) as T;
      working = base;
      return j;
    } catch (e) { last = e; }
  }
  working = undefined;
  throw last instanceof Error ? last : new Error(String(last));
}

type RawTicker = { t: number; s: string; c: string; o: string; h: string; l: string; v: string; qv: string; b: string; a: string };
const toTicker = (x: RawTicker, mult: number): Ticker => ({ last: +x.c, open: +x.o, high: +x.h, low: +x.l, volBase: +x.v * mult, volUsdt: +x.qv, bid: +x.b, ask: +x.a, at: x.t });

export async function ticker(m: Market = DEFAULT_MARKET): Promise<Ticker> {
  const [x] = await get<RawTicker[]>(`/quote/v1/ticker/24hr?symbol=${m.symbol}`);
  return toTicker(x, m.mult);
}

/** Last price and 24h change for every market in the picker (spot in one call, perps one each). */
export async function allTickers(): Promise<Record<string, Ticker>> {
  const out: Record<string, Ticker> = {};
  const [spots, ...perps] = await Promise.all([
    get<RawTicker[]>('/quote/v1/ticker/24hr'),
    ...MARKETS.filter((m) => m.kind === 'perp').map((m) => get<RawTicker[]>(`/quote/v1/ticker/24hr?symbol=${m.symbol}`).catch(() => [] as RawTicker[])),
  ]);
  for (const x of [...spots, ...perps.flat()]) {
    const m = MARKETS.find((k) => k.symbol === x.s);
    if (m) out[m.symbol] = toTicker(x, m.mult);
  }
  return out;
}

export async function depth(m: Market = DEFAULT_MARKET, limit = 12): Promise<{ bids: Level[]; asks: Level[] }> {
  const d = await get<{ b: [string, string][]; a: [string, string][] }>(`/quote/v1/depth?symbol=${m.symbol}&limit=${limit}`);
  const map = (xs: [string, string][]) => xs.map(([p, q]) => ({ price: +p, qty: +q }));
  return { bids: map(d.b), asks: map(d.a) };
}

export async function trades(m: Market = DEFAULT_MARKET, limit = 20): Promise<Trade[]> {
  const xs = await get<{ t: number; p: string; q: string; ibm: boolean }[]>(`/quote/v1/trades?symbol=${m.symbol}&limit=${limit}`);
  return xs.map((x) => ({ t: x.t, price: +x.p, qty: +x.q, buyerIsMaker: x.ibm })).sort((a, b) => b.t - a.t);
}

/** Candles oldest first. `endTime` (ms) pages back into history. */
export async function klines(m: Market, interval: Interval, limit = 500, endTime?: number): Promise<Candle[]> {
  const xs = await get<(string | number)[][]>(`/quote/v1/klines?symbol=${m.symbol}&interval=${interval}&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`);
  return xs.map((k) => ({ time: Math.floor(Number(k[0]) / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

/** Perpetuals only: mark price and the spot index it tracks. */
export async function markAndIndex(mk: Market = DEFAULT_MARKET): Promise<{ mark: number; index: number }> {
  const ix = `${mk.base}USDT`;
  const [m, i] = await Promise.all([
    get<{ price: string }>(`/quote/v1/markPrice?symbol=${mk.symbol}`),
    get<{ index: Record<string, string> }>(`/quote/v1/index?symbol=${ix}`),
  ]);
  return { mark: +m.price, index: +i.index[ix] };
}
