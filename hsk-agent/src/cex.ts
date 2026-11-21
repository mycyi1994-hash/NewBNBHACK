// HashKey Global public market data (no API key). Main market: BTC/USDT perpetual.
// Futures quantities are in contracts; 1 contract = 0.001 BTC (exchangeInfo contractMultiplier).

const BASE = 'https://api-glb.hashkey.com';
export const PERP = 'BTCUSDT-PERPETUAL';
export const CONTRACT_BTC = 0.001;

export interface Ticker { last: number; open: number; high: number; low: number; volContracts: number; volUsdt: number; bid: number; ask: number; at: number }
export interface Level { price: number; qty: number }
export interface Trade { t: number; price: number; qty: number; buyerIsMaker: boolean }
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export type Interval = '1m' | '15m' | '1h' | '4h';

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`HashKey Global HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function ticker(): Promise<Ticker> {
  const [x] = await get<{ t: number; c: string; o: string; h: string; l: string; v: string; qv: string; b: string; a: string }[]>(`/quote/v1/ticker/24hr?symbol=${PERP}`);
  return { last: +x.c, open: +x.o, high: +x.h, low: +x.l, volContracts: +x.v, volUsdt: +x.qv, bid: +x.b, ask: +x.a, at: x.t };
}

export async function depth(limit = 12): Promise<{ bids: Level[]; asks: Level[] }> {
  const d = await get<{ b: [string, string][]; a: [string, string][] }>(`/quote/v1/depth?symbol=${PERP}&limit=${limit}`);
  const map = (xs: [string, string][]) => xs.map(([p, q]) => ({ price: +p, qty: +q }));
  return { bids: map(d.b), asks: map(d.a) };
}

export async function trades(limit = 20): Promise<Trade[]> {
  const xs = await get<{ t: number; p: string; q: string; ibm: boolean }[]>(`/quote/v1/trades?symbol=${PERP}&limit=${limit}`);
  return xs.map((x) => ({ t: x.t, price: +x.p, qty: +x.q, buyerIsMaker: x.ibm })).sort((a, b) => b.t - a.t);
}

export async function klines(interval: Interval, limit = 200): Promise<Candle[]> {
  const xs = await get<(string | number)[][]>(`/quote/v1/klines?symbol=${PERP}&interval=${interval}&limit=${limit}`);
  return xs.map((k) => ({ time: Math.floor(Number(k[0]) / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

export async function markAndIndex(): Promise<{ mark: number; index: number }> {
  const [m, i] = await Promise.all([
    get<{ price: string }>(`/quote/v1/markPrice?symbol=${PERP}`),
    get<{ index: Record<string, string> }>(`/quote/v1/index?symbol=BTCUSDT`),
  ]);
  return { mark: +m.price, index: +i.index.BTCUSDT };
}
