// The spread engine: how far the HSKSwap pool price is from the exchange price, and what is left of that gap after
// what it costs to act on it. Pure functions plus two small loaders (live prices, recorded history).
//
// Costs counted:
//  - the HSKSwap pool fee, 0.3% per swap (the pool's own fee tier);
//  - the exchange's taker fee, ASSUMED 0.1% (HashKey Global's and Gate's base spot tier; a higher tier pays less);
//  - price impact on HSKSwap for the size, from the pool's real liquidity on chain (src/depth.ts), as the average
//    price paid, not the last tick touched.
// Not counted, and said so on screen: moving coins or USDT between HSK Chain and the exchange (withdrawal fees,
// bridge or transfer time, during which the gap can close), the exchange's own order book depth, and gas on HSK Chain
// (a few cents).
//
// The only thing Moa can act on inside a vault (long only, spot, HSKSwap only) is the discount side: buy the coin
// on HSKSwap when the pool is cheaper than the exchange by more than a round trip costs, and sell it back on HSKSwap
// when the discount has closed. That is the spread hunter (hunterAgent below).
import type { Asset } from './intent.ts';
import { buyImpact, type PoolState } from './depth.ts';
import { POOLS, poolState } from './dex.ts';
import * as cex from './cex.ts';
import type { Agent, Mark } from './agents.ts';

export const POOL_FEE = 0.003;
/** Assumed exchange taker fee (base tier). Shown wherever a net number is shown. */
export const TAKER_FEE = 0.001;
export const SIZES = [10, 100, 1000] as const;
/** The size the recorded history and the hunter's thresholds are costed at. */
export const REF_USD = 100;
/** How often the server records a gap. */
export const RECORD_EVERY_MS = 5 * 60_000;
/** How much history is kept (days). */
export const KEEP_DAYS = 14;
/** The hunter shows a past result only once the record covers this much time and this many points. */
export const MIN_SPAN_MS = 24 * 3_600_000;
export const MIN_POINTS = 100;

const sqrtAt = (tick: number) => Math.pow(1.0001, tick / 2);

/** How far a sale of `usd` worth of the coin moves the pool price down (0.01 = 1%), after the pool's fee. */
export function sellImpact(p: PoolState, usd: number): number {
  const price = p.sqrtPrice * p.sqrtPrice;             // raw USDT per raw coin
  if (!(price > 0) || !(p.liquidity > 0)) return Infinity;
  let left = ((usd * 1e6) / price) * (1 - POOL_FEE), at = p.sqrtPrice, L = p.liquidity;
  for (const t of p.ticks.filter((x) => x.tick <= p.tick).sort((a, b) => b.tick - a.tick)) {
    const edge = sqrtAt(t.tick), need = L * (1 / edge - 1 / at);
    if (L <= 0 || need >= left) break;
    left -= need; at = edge; L -= t.net;
  }
  if (L <= 0) return Infinity;
  const end = 1 / (1 / at + left / L);
  return 1 - (end / p.sqrtPrice) ** 2;
}

/**
 * What a swap of this size costs above (buy) or below (sell) the price before it, on average. Between two prices
 * on one stretch of liquidity a swap fills at their geometric mean, about half of how far it moved the price.
 */
export const buySlip = (p: PoolState, usd: number) => { const m = buyImpact(p, usd); return Number.isFinite(m) ? Math.sqrt(1 + m) - 1 : Infinity; };
export const sellSlip = (p: PoolState, usd: number) => { const m = sellImpact(p, usd); return Number.isFinite(m) && m < 1 ? 1 - Math.sqrt(1 - m) : Infinity; };

export type Venue = 'HashKey Global' | 'Gate';
export interface SizeEdge { usd: number; slip: number; net: number }
export interface Spread {
  asset: Asset; pool: number; exchange: number; venue: Venue;
  /** pool ÷ exchange − 1: below zero the pool is cheaper. */
  gap: number;
  /** Which way an arbitrage would go: buy on HSKSwap and sell on the exchange, or the other way. */
  side: 'poolCheap' | 'poolDear';
  /** What buying on one venue and selling on the other would earn before costs. */
  gross: number;
  /** Pool fee plus the assumed taker fee. */
  fees: number;
  /** After every counted cost, for each size. Undefined slip/net: the pool's depth was not available. */
  sizes: SizeEdge[];
  /** The largest size (USD) still worth it; 0 when no size is. Undefined without the pool's depth. */
  breakEven?: number;
}

/** The gap between HSKSwap and an exchange for one coin, with what is left of it after costs at each size. */
export function spreadOf(i: { asset: Asset; pool: number; exchange: number; venue: Venue; state?: PoolState | null }, sizes: readonly number[] = SIZES): Spread {
  const gap = i.pool / i.exchange - 1;
  const side = gap < 0 ? 'poolCheap' : 'poolDear';
  const gross = side === 'poolCheap' ? i.exchange / i.pool - 1 : i.pool / i.exchange - 1;
  const fees = POOL_FEE + TAKER_FEE;
  const slipAt = (usd: number) => (i.state ? (side === 'poolCheap' ? buySlip(i.state, usd) : sellSlip(i.state, usd)) : NaN);
  const netAt = (usd: number) => gross - fees - slipAt(usd);
  const out: Spread = { asset: i.asset, pool: i.pool, exchange: i.exchange, venue: i.venue, gap, side, gross, fees, sizes: sizes.map((usd) => ({ usd, slip: slipAt(usd), net: netAt(usd) })) };
  if (i.state) out.breakEven = breakEven(netAt);
  return out;
}

/** The largest size where `net` is still above zero (net falls as the size grows). 0 when even $1 is not worth it. */
export function breakEven(net: (usd: number) => number, max = 10_000_000): number {
  if (!(net(1) > 0)) return 0;
  if (net(max) > 0) return max;
  let lo = 1, hi = max;
  for (let k = 0; k < 60 && hi / lo > 1.001; k++) { const mid = Math.sqrt(lo * hi); if (net(mid) > 0) lo = mid; else hi = mid; }
  return Math.floor(lo);
}

/* ---------- recorded history ---------- */

/** One record: prices, and the pool's average slip at REF_USD both ways, read at that moment. */
export interface GapPoint { t: number; pool: number; hk?: number; gate?: number; buy?: number; sell?: number }

/** The exchange price a record is compared with: HashKey Global, or Gate when HashKey Global was not read. */
export const refOf = (p: GapPoint) => p.hk ?? p.gate;
export const gapOf = (p: GapPoint) => { const r = refOf(p); return r ? p.pool / r - 1 : undefined; };
/** The band a gap must leave before an arbitrage at REF_USD pays: [lower, upper]. */
export function costBand(p: Pick<GapPoint, 'buy' | 'sell'>): [number, number] {
  return [-(POOL_FEE + TAKER_FEE + (p.buy ?? 0)), POOL_FEE + TAKER_FEE + (p.sell ?? 0)];
}
/** A round trip on HSKSwap only (buy, later sell back), at REF_USD: what the hunter's discount must beat. */
export const roundTrip = (p: Pick<GapPoint, 'buy' | 'sell'>) => 2 * POOL_FEE + (p.buy ?? 0) + (p.sell ?? 0);

/** Points from the last `ms`, oldest first. */
export const lastOf = (xs: GapPoint[], ms: number, now = Date.now()) => xs.filter((p) => p.t >= now - ms).sort((a, b) => a.t - b.t);

/** How often (share of the records) the gap was outside the cost band, and the widest it got. */
export function gapStats(xs: GapPoint[]) {
  let outside = 0, n = 0, widest = 0;
  for (const p of xs) {
    const g = gapOf(p);
    if (g === undefined) continue;
    n++;
    const [lo, hi] = costBand(p);
    if (g < lo || g > hi) outside++;
    if (Math.abs(g) > Math.abs(widest)) widest = g;
  }
  return { n, outside, widest };
}

/* ---------- the spread hunter ---------- */

export type HunterState = { building: true; points: number; spanMs: number } | { building: false };
/**
 * The hunter's rule, walked over the records: in when the pool is cheaper than the exchange by more than a round
 * trip on HSKSwap costs (at REF_USD), out when the pool is back at or above the exchange. Buys and sells are priced
 * at the pool price with the recorded fee and slip, so the result is what the vault would have got on HSKSwap.
 */
export function hunterRun(xs: GapPoint[]) {
  const pts = [...xs].filter((p) => gapOf(p) !== undefined).sort((a, b) => a.t - b.t);
  let cash = 1, qty = 0, peak = 1, maxDd = 0, trades = 0, inside = 0;
  const equity: { time: number; value: number }[] = [], bench: { time: number; value: number }[] = [], marks: Mark[] = [];
  const p0 = pts[0]?.pool ?? 1;
  let lastBuy = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], g = gapOf(p)!;
    if (qty === 0 && g < -roundTrip(p)) {
      lastBuy = p.pool * (1 + (p.buy ?? 0));
      qty = (cash * (1 - POOL_FEE)) / lastBuy; cash = 0; trades++;
      marks.push({ time: Math.floor(p.t / 1000), side: 'buy', price: p.pool });
    } else if (qty > 0 && g >= 0) {
      const got = qty * p.pool * (1 - (p.sell ?? 0)) * (1 - POOL_FEE);
      marks.push({ time: Math.floor(p.t / 1000), side: 'sell', price: p.pool, ret: got / (qty * lastBuy / (1 - POOL_FEE)) - 1 });
      cash = got; qty = 0;
    }
    if (qty > 0 && k > 0) inside += p.t - pts[k - 1].t;
    const v = cash + qty * p.pool;
    peak = Math.max(peak, v); maxDd = Math.max(maxDd, 1 - v / peak);
    equity.push({ time: Math.floor(p.t / 1000), value: v });
    bench.push({ time: Math.floor(p.t / 1000), value: p.pool / p0 });
  }
  const span = pts.length > 1 ? pts[pts.length - 1].t - pts[0].t : 0;
  return { pts, equity, bench, marks, trades, maxDd, holding: qty > 0, inMarket: span ? inside / span : 0, span };
}

export function hunterState(xs: GapPoint[]): HunterState {
  const pts = xs.filter((p) => gapOf(p) !== undefined);
  const span = pts.length > 1 ? Math.max(...pts.map((p) => p.t)) - Math.min(...pts.map((p) => p.t)) : 0;
  return span >= MIN_SPAN_MS && pts.length >= MIN_POINTS ? { building: false } : { building: true, points: pts.length, spanMs: span };
}

/**
 * The hunter as a market agent, so it is hired, asked and run like every other agent (position: in or out).
 * Its in/out comes from the records; with too little history its result numbers are zero and `hunterState` says
 * it is still recording, which the screen shows instead of a result.
 */
export function hunterAgent(asset: Asset, xs: GapPoint[]): Agent {
  const r = hunterRun(xs);
  const last = r.pts[r.pts.length - 1];
  const building = hunterState(xs).building;
  const endV = r.equity[r.equity.length - 1]?.value ?? 1, endB = r.bench[r.bench.length - 1]?.value ?? 1;
  return {
    id: `spread-${asset}`, kind: 'position', rule: 'spread', style: 'revert', risk: 2, tier: 3, base: asset, runnable: true, source: 'hashkey',
    fee: POOL_FEE, days: Math.max(1, Math.round(r.span / 86_400_000)), from: Math.floor((r.pts[0]?.t ?? Date.now()) / 1000), to: Math.floor((last?.t ?? Date.now()) / 1000),
    total: building ? 0 : endV - 1, hold: building ? 0 : endB - 1, maxDd: building ? 0 : r.maxDd, sharpe: 0, trades: r.trades, inMarket: r.inMarket,
    equity: building ? [] : r.equity, bench: building ? [] : r.bench, marks: r.marks, live: r.holding, mult: r.holding ? 1 : 0, price: last?.pool ?? 0,
  };
}

/* ---------- loaders ---------- */

const GATE_PAIR: Record<Asset, string> = { BTC: 'BTC_USDT', ETH: 'ETH_USDT', HSK: 'HSK_USDT' };
async function gateLast(asset: Asset): Promise<number> {
  const r = await fetch(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${GATE_PAIR[asset]}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Gate HTTP ${r.status}`);
  const x = ((await r.json()) as { last: string }[])[0];
  const v = Number(x?.last);
  if (!(v > 0)) throw new Error('Gate: no price');
  return v;
}
const hkSpot = (asset: Asset) => cex.ticker(cex.MARKETS.find((m) => m.kind === 'spot' && m.base === asset) ?? cex.DEFAULT_MARKET).then((t) => { if (!(t.last > 0)) throw new Error('HashKey Global: no price'); return t.last; });

/** One live read: the pool (with its depth), HashKey Global and Gate. A source that fails is left out, never guessed. */
export async function readNow(asset: Asset, now = Date.now()): Promise<{ point: GapPoint; state: PoolState } | null> {
  const [st, hk, gate] = await Promise.allSettled([poolState(asset), hkSpot(asset), gateLast(asset)]);
  if (st.status !== 'fulfilled') return null;
  const state = st.value, pool = state.sqrtPrice ** 2 * 10 ** (POOLS[asset].decimals - 6);
  const point: GapPoint = { t: now, pool };
  if (hk.status === 'fulfilled') point.hk = hk.value;
  if (gate.status === 'fulfilled') point.gate = gate.value;
  const b = buySlip(state, REF_USD), sl = sellSlip(state, REF_USD);
  if (Number.isFinite(b)) point.buy = +b.toFixed(6);
  if (Number.isFinite(sl)) point.sell = +sl.toFixed(6);
  return { point, state };
}
/** The spread now for one coin, against HashKey Global (or Gate when HashKey Global did not answer). */
export async function liveSpread(asset: Asset): Promise<Spread | null> {
  const r = await readNow(asset);
  const ref = r && refOf(r.point);
  if (!r || !ref) return null;
  return spreadOf({ asset, pool: r.point.pool, exchange: ref, venue: r.point.hk ? 'HashKey Global' : 'Gate', state: r.state });
}

/** Where the records come from: the server's own recorder in the server, its API in the browser. */
let source: (asset: Asset, days: number) => Promise<GapPoint[]> = async (asset, days) => {
  const r = await fetch(`/api/spread?asset=${asset}&days=${days}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`spread history HTTP ${r.status}`);
  return ((await r.json()) as { points: GapPoint[] }).points;
};
export const setGapSource = (f: typeof source) => { source = f; };
export const gapHistory = (asset: Asset, days = 7) => source(asset, days);
export const spreadAgent = async (asset: Asset) => hunterAgent(asset, await gapHistory(asset, KEEP_DAYS));

/** A short, plain read of every coin's spread now, in the user's language (Moa's answer to "any arbitrage?"). */
export function spreadBrief(xs: Spread[], lang: 'en' | 'ko'): string {
  const pc = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)}%`;
  if (!xs.length) return lang === 'ko' ? '지금은 가격을 읽지 못했어요. 잠시 뒤에 다시 물어봐 주세요.' : 'I could not read the prices just now. Ask me again in a moment.';
  const lines = xs.map((s) => {
    const n100 = s.sizes.find((z) => z.usd === 100)?.net;
    const where = s.side === 'poolCheap' ? (lang === 'ko' ? 'HSKSwap이 더 싸요' : 'HSKSwap is cheaper') : (lang === 'ko' ? 'HSKSwap이 더 비싸요' : 'HSKSwap is dearer');
    const net = n100 === undefined || Number.isNaN(n100) ? '' : lang === 'ko' ? `, 비용 빼면 $100 기준 ${pc(n100)}` : `, ${pc(n100)} after costs at $100`;
    return `${s.asset}: ${pc(s.gap)} (${where}${net})`;
  });
  const any = xs.some((s) => (s.sizes.find((z) => z.usd === 100)?.net ?? -1) > 0);
  const head = lang === 'ko'
    ? (any ? '비용을 넘는 차이가 있어요.' : '지금은 비용을 넘는 차이가 없어요.')
    : (any ? 'There is a gap that beats the costs.' : 'No gap beats the costs right now.');
  const tail = lang === 'ko'
    ? '비용: HSKSwap 수수료 0.3%, 거래소 수수료 0.1%(가정), 풀 가격 영향. 거래소로 옮기는 시간과 비용은 빠져 있어요.'
    : 'Costs: HSKSwap fee 0.3%, exchange fee 0.1% (assumed), pool price impact. Moving funds to the exchange is not counted.';
  const act = lang === 'ko'
    ? '볼트는 HSKSwap에서만 거래해요. HSKSwap이 쌀 때 사서 차이가 닫히면 파는 스프레드 헌터를 트레이드 화면의 스프레드 탭에서 맡길 수 있어요.'
    : 'Your vault trades only on HSKSwap. The Spread Hunter (Spread tab on the trade screen) buys there at a discount and sells when it closes.';
  return [head, ...lines, tail, act].join('\n');
}
