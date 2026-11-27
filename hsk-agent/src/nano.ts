// Order-book heatmap and liquidations from nanotradingclub's public files: the resting orders of nine exchanges
// (Binance, Bybit, Hyperliquid, Gate, Bitfinex, Upbit, Bithumb; futures and spot) folded into price bins, and the
// forced orders their futures markets reported. Exchange data, not HSK Chain data. Nothing here is fetched until
// someone turns the layer on (or Moa is asked), and then at most once every three minutes.
const CDN = 'https://cdn.nanotradingclub.xyz';
export const NANO_REFRESH_MS = 180_000;
export const NANO_SOURCE = 'nanotradingclub';

/** One moment of the book: bin i covers prices from lo + i*step, `bins[i]` is the USD resting there. */
export interface HeatColumn { t: number; mid: number; lo: number; step: number; bins: Float32Array }
/**
 * Forced orders. `long` says whose position was closed: a long (forced sell) or a short (forced buy).
 * The last few hours come one order at a time; older ones come summed per quarter hour, hour or day (`sum`),
 * at the average price of that stretch.
 */
export interface Liq { t: number; price: number; usd: number; long: boolean; sum: boolean }

interface RawColumn { t: number; mid: number; lo: number; step: number; n?: number; bins?: number[]; ix?: number[]; bv?: number[] }
const symbolOf = (base: string) => `${base.toUpperCase()}USDT`;

async function get<T>(name: string): Promise<T> {
  const r = await fetch(`${CDN}/${name}`);
  if (r.status === 404) throw new NoData();
  if (!r.ok) throw new Error(`nanotradingclub answered ${r.status}`);
  return (await r.json()) as T;
}
/** The coin is not one nanotradingclub collects. */
export class NoData extends Error { constructor() { super('no data for this coin'); } }

function column(c: RawColumn): HeatColumn | null {
  if (!c || !Number.isFinite(c.lo) || !Number.isFinite(c.step) || c.step <= 0) return null;
  let bins: Float32Array;
  if (c.bins) bins = Float32Array.from(c.bins);
  else if (c.ix && c.bv) { bins = new Float32Array(c.n ?? 2048); c.ix.forEach((i, k) => { if (i >= 0 && i < bins.length) bins[i] = c.bv![k]; }); }
  else return null;
  return { t: c.t, mid: c.mid, lo: c.lo, step: c.step, bins };
}

/** The book right now. */
export async function heatNow(base: string): Promise<HeatColumn> {
  const j = await get<{ col: RawColumn }>(`fire_latest_${symbolOf(base)}.json`);
  const c = column(j.col);
  if (!c) throw new Error('unreadable heatmap column');
  return c;
}
/** The book over the months nanotradingclub has kept (coarser the older it is), oldest first, ending with the book right now. */
export async function heatHistory(base: string): Promise<HeatColumn[]> {
  const file = (name: string) => get<{ cols: RawColumn[] }>(`${name}_${symbolOf(base)}.json`).catch((e) => { if (e instanceof NoData) throw e; return { cols: [] as RawColumn[] }; });
  // Three files, coarse to fine: months of history (about 12 MB on the wire, read once), the last hour, and now.
  const [long, tail, now] = await Promise.all([file('fire_long'), file('fire_long_tail'), heatNow(base)]);
  const tidy = (cols: RawColumn[], before: number) => cols.map(column).filter((c): c is HeatColumn => c !== null && c.t < before - 20).sort((a, b) => a.t - b.t);
  const recent = tidy(tail.cols, now.t);
  return [...tidy(long.cols, recent[0]?.t ?? now.t), ...recent, now];
}
/** Adds the book right now to what is already on screen. */
export async function heatRefresh(base: string, have: HeatColumn[]): Promise<HeatColumn[]> {
  const now = await heatNow(base);
  const last = have[have.length - 1];
  return last && now.t - last.t < 20 ? have : [...have, now];
}

export async function liquidations(base: string): Promise<Liq[]> {
  const j = await get<{ liq: { t: number; p: number; u: number; S: string }[] }>(`liq_long_${symbolOf(base)}.json`);
  return j.liq.filter((x) => x.u > 0 && x.p > 0).map((x) => ({ t: x.t, price: x.p, usd: x.u, long: x.S === 'SELL', sum: x.t % 900 === 0 }));
}

/**
 * The colour scale for the prices on screen: [what a typical bin holds, what the thickest holds]. A typical bin is
 * left blank and the thickest gets the darkest colour, so walls stand out at any zoom.
 */
export function heatScale(c: HeatColumn, low: number, high: number): [number, number] {
  const from = Math.max(0, Math.floor((low - c.lo) / c.step)), to = Math.min(c.bins.length - 1, Math.ceil((high - c.lo) / c.step));
  const seen: number[] = [];
  for (let i = from; i <= to; i++) if (c.bins[i] > 0) seen.push(c.bins[i]);
  if (!seen.length) return [0, 1];
  seen.sort((a, b) => a - b);
  const typical = seen[Math.floor(seen.length * 0.5)], thick = seen[Math.min(seen.length - 1, Math.floor(seen.length * 0.99))];
  return [typical, Math.max(thick, typical * 1.5, typical + 1)];
}

/* ---------- the liquidation map: an estimate, not a record ---------- */

/** Open interest of the coin's largest futures market, in coins (hourly; the newest value). */
export async function openInterest(base: string): Promise<number> {
  const j = await get<{ oi: [number, number][] }>(`oi_long_${symbolOf(base)}.json`);
  const last = j.oi[j.oi.length - 1]?.[1];
  if (!(last > 0)) throw new Error('no open interest');
  return last;
}

/** Leverage and how common it is taken to be, from 2x (liquidated 50% away) to 125x (0.8% away). */
const LEVERAGE: [number, number][] = [[2, .45], [3, .55], [4, .6], [5, .8], [6, .6], [8, .7], [10, 1], [12, .6], [15, .7], [20, .9], [25, .95], [35, .6], [50, .9], [75, .55], [100, .85], [125, .5]];
const MAINTENANCE = 0.004;
export interface LiqMap { n: number; low: number; step: number; /** USD per price bin, by leverage group: up to 8x, up to 28x, above. */ lowLev: Float64Array; midLev: Float64Array; highLev: Float64Array }

/**
 * Where positions would be liquidated, estimated the way nanotradingclub's liquidation map does it: the open
 * interest is spread over entry prices in proportion to the volume traded at each candle, half long and half
 * short, across a fixed mix of leverage. Each slice lands at its liquidation price (entry less 1/leverage for a
 * long, plus for a short, with the maintenance margin taken off). An estimate from assumptions, not positions.
 */
export function liqMap(bars: { high: number; low: number; close: number; volume: number }[], oiUsd: number, low: number, high: number, n: number, longShare = 0.5): LiqMap | null {
  if (!(oiUsd > 0) || !(high > low) || n < 1 || !bars.length) return null;
  const step = (high - low) / n, out: LiqMap = { n, low, step, lowLev: new Float64Array(n), midLev: new Float64Array(n), highLev: new Float64Array(n) };
  const weight = (b: { close: number; volume: number }) => b.volume * b.close;
  const total = bars.reduce((s, b) => s + weight(b), 0), mix = LEVERAGE.reduce((s, l) => s + l[1], 0);
  if (!(total > 0)) return null;
  for (const b of bars) {
    const entry = (b.high + b.low) / 2, w = weight(b) / total;
    if (!(entry > 0) || !(w > 0)) continue;
    for (const [lev, share] of LEVERAGE) {
      const into = lev <= 8 ? out.lowLev : lev <= 28 ? out.midLev : out.highLev, part = oiUsd * w * (share / mix);
      const longAt = Math.floor((entry * (1 - 1 / lev + MAINTENANCE) - low) / step), shortAt = Math.floor((entry * (1 + 1 / lev - MAINTENANCE) - low) / step);
      if (longAt >= 0 && longAt < n) into[longAt] += part * longShare;
      if (shortAt >= 0 && shortAt < n) into[shortAt] += part * (1 - longShare);
    }
  }
  return out;
}

/* ---------- the few numbers Moa is given ---------- */

export interface Wall { price: number; usd: number; awayPct: number }
export interface NanoBrief {
  coin: string; price: number; asOf: string;
  /** The thickest stacks of resting orders within 8% of the price, nearest first. */
  buyWalls: Wall[]; sellWalls: Wall[];
  /** Forced orders, USD. longs = long positions closed, shorts = short positions closed. */
  liquidations?: { lastHour: { longs: number; shorts: number }; last24h: { longs: number; shorts: number }; biggestLastHour?: { price: number; usd: number; side: 'long' | 'short'; minutesAgo: number } };
}

/** The three thickest stretches on one side of the price. Neighbouring bins count as one wall. */
export function walls(c: HeatColumn, side: 'buy' | 'sell', reach = 0.08, groupPct = 0.004): Wall[] {
  const width = Math.max(1, Math.round((c.mid * groupPct) / c.step));
  const mid = (c.mid - c.lo) / c.step;
  // The bin the price is in holds both sides of the book, so each side starts one bin away from it.
  const from = side === 'buy' ? Math.max(0, Math.floor(mid - (c.mid * reach) / c.step)) : Math.floor(mid) + 1;
  const to = side === 'buy' ? Math.floor(mid) - 1 : Math.min(c.bins.length - 1, Math.ceil(mid + (c.mid * reach) / c.step));
  const groups: Wall[] = [];
  for (let i = from; i <= to; i += width) {
    let usd = 0, top = i;
    for (let k = i; k < Math.min(i + width, to + 1); k++) { usd += c.bins[k]; if (c.bins[k] > c.bins[top]) top = k; }
    const price = c.lo + (top + 0.5) * c.step;
    if (usd > 0) groups.push({ price: Math.round(price * 100) / 100, usd: Math.round(usd), awayPct: Math.round((price / c.mid - 1) * 1e4) / 100 });
  }
  return groups.sort((a, b) => b.usd - a.usd).slice(0, 3).sort((a, b) => Math.abs(a.awayPct) - Math.abs(b.awayPct));
}

export function briefOf(coin: string, c: HeatColumn, liqs: Liq[] | null, nowSec = Date.now() / 1000): NanoBrief {
  const out: NanoBrief = { coin, price: Math.round(c.mid * 100) / 100, asOf: new Date(c.t * 1000).toISOString(), buyWalls: walls(c, 'buy'), sellWalls: walls(c, 'sell') };
  if (liqs) {
    const sum = (from: number) => {
      const s = { longs: 0, shorts: 0 };
      for (const x of liqs) if (x.t >= from) s[x.long ? 'longs' : 'shorts'] += x.usd;
      return { longs: Math.round(s.longs), shorts: Math.round(s.shorts) };
    };
    // Single orders only: older records are sums over a stretch of time, not one order.
    const big = liqs.filter((x) => x.t >= nowSec - 3600 && !x.sum).reduce<Liq | null>((m, x) => (!m || x.usd > m.usd ? x : m), null);
    out.liquidations = {
      lastHour: sum(nowSec - 3600), last24h: sum(nowSec - 86_400),
      ...(big ? { biggestLastHour: { price: Math.round(big.price * 100) / 100, usd: Math.round(big.usd), side: big.long ? 'long' as const : 'short' as const, minutesAgo: Math.round((nowSec - big.t) / 60) } } : {}),
    };
  }
  return out;
}

const kept = new Map<string, { at: number; brief: NanoBrief }>();
/** For the server: the brief for one coin, fetched at most once every three minutes. Null when the coin has no data. */
export async function nanoBrief(coin: string): Promise<NanoBrief | null> {
  const had = kept.get(coin);
  if (had && Date.now() - had.at < NANO_REFRESH_MS) return had.brief;
  try {
    const [c, liqs] = await Promise.all([heatNow(coin), liquidations(coin).catch(() => null)]);
    const brief = briefOf(coin, c, liqs);
    kept.set(coin, { at: Date.now(), brief });
    return brief;
  } catch (e) {
    if (e instanceof NoData) return null;
    throw e;
  }
}
