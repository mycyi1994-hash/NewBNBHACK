// On-chain watch for HSK: what the WHSK/USDT pool on HSK Chain itself says, read from the chain's own logs.
//  - Swap flow: every Swap event of the pool, split into buys (USDT in, WHSK out) and sells, summed in USDT over the
//    last 24 hours, the last 7 days and day by day for as far back as the server has read (it reads 30 days).
//  - Liquidity: the USDT it takes to move the pool 2% either way (src/depth.ts), recorded with each read, so the
//    change over a day shows whether liquidity is arriving or leaving.
// It is a live reading, not a trading rule: 30 days of flows is too short to test one honestly, so no agent trades
// on it and no past result is shown. Large token transfers outside the pool are not read.
import type { Asset } from './intent.ts';

export interface FlowSwap { block: number; time: number; side: 'buy' | 'sell'; usdt: number; price: number; tx: string }
export interface Flow { buy: number; sell: number; net: number; count: number; largest?: FlowSwap }
export interface DayFlow { day: number; buy: number; sell: number; net: number; count: number }
export interface LiqPoint { t: number; usd: number }
/** Who is in charge of the pool's flow: buyers, sellers, about even, or too little trading to say. */
export type FlowSide = 'buyers' | 'sellers' | 'even' | 'quiet';
export interface OnchainView {
  /** `at`: the moment the chain was last read up to its newest block; every window below ends there. */
  asset: Asset; at: number;
  /** The oldest moment read: flows before it are unknown, not zero. The server reads further back over its first hour. */
  since: number;
  day: Flow; week: Flow; side: FlowSide;
  days: DayFlow[];
  price?: number;
  liquidity?: { now: number; dayAgo?: number };
}

/** Under this much traded in a day, the pool is "quiet": a few swaps say nothing about direction. */
export const QUIET_USD = 200;
/** Net flow this large a share of all trading (20%) leans one way. */
export const LEAN = 0.2;
const DAY = 86_400_000;

export function flowOf(swaps: FlowSwap[], from: number, to: number): Flow {
  let buy = 0, sell = 0, count = 0, largest: FlowSwap | undefined;
  for (const s of swaps) {
    if (s.time < from || s.time > to) continue;
    count++;
    if (s.side === 'buy') buy += s.usdt; else sell += s.usdt;
    if (!largest || s.usdt > largest.usdt) largest = s;
  }
  return { buy, sell, net: buy - sell, count, largest };
}

export function sideOf(f: Pick<Flow, 'buy' | 'sell' | 'net'>): FlowSide {
  const vol = f.buy + f.sell;
  if (vol < QUIET_USD) return 'quiet';
  return f.net / vol >= LEAN ? 'buyers' : f.net / vol <= -LEAN ? 'sellers' : 'even';
}

/** Day by day (UTC days), oldest first, only for days fully or partly inside what was read. */
export function dailyFlows(swaps: FlowSwap[], since: number, now: number): DayFlow[] {
  const first = Math.floor(since / DAY) * DAY, out: DayFlow[] = [];
  for (let d = first; d <= now; d += DAY) {
    const f = flowOf(swaps, d, d + DAY - 1);
    out.push({ day: d, buy: f.buy, sell: f.sell, net: f.net, count: f.count });
  }
  return out;
}

/** The liquidity record nearest to a day before the last one, if the record reaches that far back (20 hours at least). */
export function dayAgo(liq: LiqPoint[], now: number): number | undefined {
  const old = liq.filter((x) => x.t <= now - 20 * 3_600_000);
  if (!old.length) return undefined;
  return old.reduce((best, x) => (Math.abs(x.t - (now - DAY)) < Math.abs(best.t - (now - DAY)) ? x : best)).usd;
}

export function viewOf(asset: Asset, swaps: FlowSwap[], since: number, liq: LiqPoint[], now: number): OnchainView {
  const day = flowOf(swaps, now - DAY, now), week = flowOf(swaps, now - 7 * DAY, now);
  const newest = swaps.reduce<FlowSwap | undefined>((a, s) => (!a || s.block > a.block ? s : a), undefined);
  const last = liq.length ? liq[liq.length - 1] : undefined;
  return {
    asset, at: now, since, day, week, side: sideOf(day), days: dailyFlows(swaps, since, now),
    ...(newest ? { price: newest.price } : {}),
    ...(last ? { liquidity: { now: last.usd, ...(dayAgo(liq, now) !== undefined ? { dayAgo: dayAgo(liq, now) } : {}) } } : {}),
  };
}

/** Whether the read reaches back the whole 7 days the week's numbers add up. */
export const weekRead = (v: Pick<OnchainView, 'at' | 'since'>) => v.at - v.since >= 7 * DAY - 60_000;

/* ---------- where the view comes from: the server's reader in the server, its API in the browser ---------- */

let source: (asset: Asset) => Promise<OnchainView | null> = async (asset) => {
  const r = await fetch(`/api/onchain?asset=${asset}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`on-chain watch HTTP ${r.status}`);
  return ((await r.json()) as { view: OnchainView | null }).view;
};
export const setOnchainSource = (f: typeof source) => { source = f; };
export const onchainView = (asset: Asset = 'HSK') => source(asset);

/** The view in plain numbers for Moa (get_market). */
export function onchainForModel(v: OnchainView | null) {
  if (!v) return { unavailable: 'the on-chain reader has not finished reading its first day yet' };
  const r = (x: number) => Math.round(x);
  return {
    source: 'Swap events of the HSKSwap WHSK/USDT pool on HSK Chain, read from the chain',
    readSince: new Date(v.since).toISOString(), readUntil: new Date(v.at).toISOString(),
    last24h: { buyUsd: r(v.day.buy), sellUsd: r(v.day.sell), netUsd: r(v.day.net), swaps: v.day.count, leaning: v.side, largestSwapUsd: v.day.largest ? r(v.day.largest.usdt) : null },
    last7d: weekRead(v) ? { buyUsd: r(v.week.buy), sellUsd: r(v.week.sell), netUsd: r(v.week.net), swaps: v.week.count } : 'not read that far back yet',
    liquidityWithin2PctUsd: v.liquidity ? { now: r(v.liquidity.now), dayAgo: v.liquidity.dayAgo !== undefined ? r(v.liquidity.dayAgo) : null } : null,
    note: 'A live reading, not a tested trading signal: about 30 days of flows is too short to backtest. Transfers outside the pool are not read.',
  };
}
