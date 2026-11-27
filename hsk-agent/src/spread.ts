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
  /** What a vault can do itself (HSKSwap only): buy at REF_USD and later sell back there. The round trip's cost, and
   *  what is left of the discount if the pool rises all the way to the exchange price. Pool cheaper and depth known only. */
  roundTrip?: number; vaultNet?: number;
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
  if (i.state) {
    out.breakEven = breakEven(netAt);
    if (side === 'poolCheap') { out.roundTrip = 2 * POOL_FEE + buySlip(i.state, REF_USD) + sellSlip(i.state, REF_USD); out.vaultNet = gross - out.roundTrip; }
  }
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

/** Whether the hunter has enough records for a past result (and so can be hired). */
export type HunterState = { building: true; points: number; spanMs: number } | { building: false };
/** The hunter sells after this long in the coin, whatever the gap: a pool that never trades never closes its discount. */
export const MAX_HOLD_MS = 3 * 86_400_000;
/** ...or once the pool price is this far under what it paid. */
export const STOP = 0.05;
/** A discount counts as closed in the record once the gap is back to this or above (half a round trip under the exchange). */
const closedAt = (p: GapPoint) => -roundTrip(p) / 2;

/**
 * The hunter's rule, walked over the records.
 *  In: the pool is cheaper than the exchange by more than a round trip on HSKSwap costs (at REF_USD), and the record
 *      has already shown this pool closing such a discount once (a stale pool that never trades never qualifies).
 *  Out, the first of: the pool price has risen a round trip over what it paid (the discount paid off); the pool has
 *      risen and is back at the exchange price (an exchange that falls to the pool closes nothing for the vault);
 *      MAX_HOLD_MS in the coin; or the pool price STOP under what it paid.
 * Buys and sells are priced at the pool price with the recorded fee and slip: what the vault would get on HSKSwap.
 */
export function hunterRun(xs: GapPoint[]) {
  const pts = [...xs].filter((p) => gapOf(p) !== undefined).sort((a, b) => a.t - b.t);
  let cash = 1, qty = 0, peak = 1, maxDd = 0, trades = 0, inside = 0, since = 0, entry = 0, paid = 0;
  let dip = false, reverted = false, dipGap = 0, dipPool = 0;
  const equity: { time: number; value: number }[] = [], bench: { time: number; value: number }[] = [], marks: Mark[] = [];
  const exits: ('target' | 'closed' | 'time' | 'stop')[] = [];
  const p0 = pts[0]?.pool ?? 1;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], g = gapOf(p)!, rt = roundTrip(p);
    if (qty === 0 && g < -rt && reverted) {
      entry = p.pool; paid = cash;
      qty = (cash * (1 - POOL_FEE)) / (p.pool * (1 + (p.buy ?? 0))); cash = 0; trades++; since = p.t;
      marks.push({ time: Math.floor(p.t / 1000), side: 'buy', price: p.pool });
    } else if (qty > 0) {
      const why = p.pool >= entry * (1 + rt) ? 'target' : g >= 0 && p.pool > entry ? 'closed' : p.t - since >= MAX_HOLD_MS ? 'time' : p.pool <= entry * (1 - STOP) ? 'stop' : null;
      if (why) {
        const got = qty * p.pool * (1 - (p.sell ?? 0)) * (1 - POOL_FEE);
        marks.push({ time: Math.floor(p.t / 1000), side: 'sell', price: p.pool, ret: got / paid - 1 });
        exits.push(why);
        cash = got; qty = 0;
      }
    }
    // What the record shows about this pool: a discount past a round trip, later closed BY THE POOL RISING. A gap that
    // closes because the exchange came down to the pool is no evidence: the vault only profits when the pool rises.
    // The pool must have risen at least as far as the gap narrowed from its deepest point to "closed".
    if (g < -rt) { if (!dip || g < dipGap) { dipGap = g; dipPool = p.pool; } dip = true; }
    else if (dip && g >= closedAt(p)) { if (p.pool / dipPool - 1 >= closedAt(p) - dipGap) reverted = true; dip = false; }
    if (qty > 0 && k > 0) inside += p.t - pts[k - 1].t;
    const v = cash + qty * p.pool;
    peak = Math.max(peak, v); maxDd = Math.max(maxDd, 1 - v / peak);
    equity.push({ time: Math.floor(p.t / 1000), value: v });
    bench.push({ time: Math.floor(p.t / 1000), value: p.pool / p0 });
  }
  const span = pts.length > 1 ? pts[pts.length - 1].t - pts[0].t : 0;
  return { pts, equity, bench, marks, exits, trades, maxDd, holding: qty > 0, reverted, inMarket: span ? inside / span : 0, span };
}

export function hunterState(xs: GapPoint[]): HunterState {
  const pts = xs.filter((p) => gapOf(p) !== undefined);
  const span = pts.length > 1 ? Math.max(...pts.map((p) => p.t)) - Math.min(...pts.map((p) => p.t)) : 0;
  return span >= MIN_SPAN_MS && pts.length >= MIN_POINTS ? { building: false } : { building: true, points: pts.length, spanMs: span };
}

/**
 * The hunter as a market agent, so it is hired, asked and run like every other agent (position: in or out).
 * Its in/out comes from the records; with too little history its result numbers are zero, it is not hireable
 * (runnable false), and `hunterState` says it is still recording, which the screen shows instead of a result.
 */
export function hunterAgent(asset: Asset, xs: GapPoint[]): Agent {
  const r = hunterRun(xs);
  const last = r.pts[r.pts.length - 1];
  const building = hunterState(xs).building;
  const endV = r.equity[r.equity.length - 1]?.value ?? 1, endB = r.bench[r.bench.length - 1]?.value ?? 1;
  return {
    id: `spread-${asset}`, kind: 'position', rule: 'spread', style: 'revert', risk: 2, tier: 3, base: asset, runnable: !building, source: 'hashkey',
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

/**
 * Moa's answer to "any arbitrage?", about what the vault can do: it trades only on HSKSwap and cannot sell on the
 * exchange. "Yes" only when a coin is cheaper on HSKSwap by more than a round trip there AND the record shows this pool
 * closing such a discount before; the cross-venue number is said to need an exchange account.
 */
export function spreadBrief(xs: { s: Spread; reverted: boolean }[], lang: 'en' | 'ko'): string {
  const pc = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)}%`;
  const ko = lang === 'ko';
  if (!xs.length) return ko ? '지금은 가격을 읽지 못했어요. 잠시 뒤에 다시 물어봐 주세요.' : 'I could not read the prices just now. Ask me again in a moment.';
  const can = xs.filter(({ s, reverted }) => s.vaultNet !== undefined && s.vaultNet > 0 && reverted);
  const head = can.length
    ? (ko ? `있어요: ${can.map((x) => x.s.asset).join(', ')}를 HSKSwap에서 싸게 살 수 있어요.` : `Yes: ${can.map((x) => x.s.asset).join(', ')} can be bought cheaper on HSKSwap.`)
    : (ko ? '지금은 볼트로 할 수 있는 차익이 없어요.' : 'Nothing your vault can act on right now.');
  const lines = xs.map(({ s, reverted }) => {
    if (s.side === 'poolDear') return ko ? `${s.asset}: HSKSwap이 ${pc(s.gap)} 비싸요. 볼트에 이 코인이 있으면 HSKSwap에서 파는 게 거래소보다 나아요.` : `${s.asset}: HSKSwap is ${pc(s.gap)} dearer. If the vault holds it, selling on HSKSwap beats the exchange.`;
    const net = s.vaultNet === undefined ? '' : ko ? ` 사서 HSKSwap에서 되팔면 왕복 비용 ${pc(-(s.roundTrip ?? 0))}, 풀이 거래소 가격까지 오르면 ${pc(s.vaultNet)} 남아요.` : ` Buying and selling back on HSKSwap costs ${pc(-(s.roundTrip ?? 0))} round trip; ${pc(s.vaultNet)} is left if the pool rises to the exchange price.`;
    const rec = reverted ? '' : ko ? ' 다만 이 풀이 할인을 닫은 기록이 아직 없어요.' : ' But the record has not yet shown this pool closing a discount.';
    const cross = s.sizes.find((z) => z.usd === REF_USD)?.net;
    const ex = cross === undefined || Number.isNaN(cross) ? '' : ko ? ` (거래소에서 팔 수 있을 때만 $${REF_USD} 기준 ${pc(cross)}, 볼트로는 못 해요.)` : ` (Only with an exchange account: ${pc(cross)} at $${REF_USD}; the vault cannot.)`;
    return `${s.asset}: ${ko ? `HSKSwap이 ${pc(-s.gap).replace('+', '')} 싸요.` : `HSKSwap is ${pc(-s.gap).replace('+', '')} cheaper.`}${net}${rec}${ex}`;
  });
  const tail = ko
    ? '볼트는 HSKSwap에서만 사고팔아요. 거래소로 옮겨 파는 건 할 수 없고, 그 시간과 비용도 계산에 없어요.'
    : 'Your vault buys and sells only on HSKSwap. It cannot move coins to the exchange and sell there; that time and cost are not counted.';
  const act = can.length ? (ko ? '이걸 대신 해 주는 스프레드 헌터가 트레이드 화면의 스프레드 탭에 있어요.' : 'The Spread Hunter on the trade screen’s Spread tab does this for you.') : '';
  return [head, ...lines, tail, act].filter(Boolean).join('\n');
}

/** The spread now with what the record says about this pool (has it closed a discount before?), for Moa's answer. */
export async function spreadRead(asset: Asset): Promise<{ s: Spread; reverted: boolean } | null> {
  const [s, hist] = await Promise.all([liveSpread(asset).catch(() => null), gapHistory(asset, KEEP_DAYS).catch(() => [] as GapPoint[])]);
  return s ? { s, reverted: hunterRun(hist).reverted } : null;
}
