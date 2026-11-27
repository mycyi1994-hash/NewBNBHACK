// How a backtest fills its trades: where the rule decides (exchange candles) is not where it trades (the HSKSwap
// pool), so every trade pays, per side:
//  - the pool fee, 0.3%;
//  - the pool's drift from the exchange price. The pool trades at a gap to the exchange (the "basis"). A steady gap
//    costs nothing, because the buy and the sell both meet it, and holding the coin meets it too. What does cost is how
//    much the gap moves around: measured from the pool's own swaps against the exchange's candles at the same hour
//    (mean absolute deviation from the median gap), or, with too few swaps to measure, a stated 0.5% haircut;
//  - price impact: how far an order of the assumed size moves the pool, from its real depth (ticks and liquidity),
//    taken as half the final move (the average fill of a sweep through roughly even liquidity).
// A coin with no HSKSwap pool trades on the exchange itself: 0.1% fee, no gap, no pool impact.
// Pure: the pool's state and swaps are passed in; agents.ts loads them.
import type { PoolState } from './depth.ts';
import { buyImpact } from './depth.ts';

export const POOL_FEE = 0.003;
export const EXCHANGE_FEE = 0.001;
/** Added per side when the pool's gap cannot be measured (too few swaps, or the chain cannot be read). */
export const HAIRCUT = 0.005;
/**
 * The money the backtest trades with, for price impact: the hire sheet's default budget. An on/off agent moves all
 * of it (as it grows or shrinks), a weight agent only the rebalance difference. A hire with another budget is
 * rescored at that size (agents.ts `rescoreAt`), and the detail view shows $1,000 and $10,000 beside it.
 */
export const ASSUMED_USD = 100;
/** The sizes the detail view also shows, so a thin pool's cost at size stays visible. */
export const SENSITIVITY_USD = [1000, 10000] as const;
/** Fewer swaps than this and the gap is not measured. */
export const MIN_SWAPS = 5;

export interface FillModel {
  /** 'pool': measured on HSKSwap; 'haircut': pool, but the gap could not be measured; 'exchange': no pool for the coin. */
  source: 'pool' | 'haircut' | 'exchange';
  fee: number;
  /** Per side, for the moving gap (measured) or the stated haircut. */
  slip: number;
  /** The median gap, pool price ÷ exchange price − 1 (shown; it cancels out). */
  basis?: number;
  /** Swaps the gap was measured on. */
  samples: number;
  /** The pool's depth, for price impact. */
  depth?: PoolState;
  amountUsd: number;
}

export const exchangeModel = (): FillModel => ({ source: 'exchange', fee: EXCHANGE_FEE, slip: 0, samples: 0, amountUsd: ASSUMED_USD });
export const haircutModel = (depth?: PoolState, basis?: number, samples = 0): FillModel => ({ source: 'haircut', fee: POOL_FEE, slip: HAIRCUT, samples, depth, basis, amountUsd: ASSUMED_USD });

const sqrtAt = (tick: number) => Math.pow(1.0001, tick / 2);
/** How far selling coin worth `usd` USDT moves the pool price down (0.01 = 1%): walking the ticks under the price. */
export function sellMove(p: PoolState, usd: number): number {
  let left = usd * 1e6, at = p.sqrtPrice, L = p.liquidity;
  for (const t of p.ticks.filter((x) => x.tick <= p.tick).sort((a, b) => b.tick - a.tick)) {
    const edge = sqrtAt(t.tick), give = L * (at - edge);
    if (L <= 0 || give >= left) break;
    left -= give; at = edge; L -= t.net;
  }
  if (L <= 0) return Infinity;
  at -= left / L;
  return at <= 0 ? Infinity : 1 - (at / p.sqrtPrice) ** 2;
}
/** The average fill's distance from the pool price for an order of `usd`: half the final move. */
export function impact(p: PoolState | undefined, usd: number, side: 'buy' | 'sell'): number {
  if (!p || usd <= 0) return 0;
  const move = side === 'buy' ? buyImpact(p, usd) : sellMove(p, usd);
  return Number.isFinite(move) ? Math.min(0.5, Math.abs(move) / 2) : 0.5;
}
/** Everything one side of a trade of `usd` costs, as a share of what is traded. */
export function sideCost(m: FillModel, usd: number, side: 'buy' | 'sell'): number {
  return m.fee + m.slip + (m.source === 'exchange' ? 0 : impact(m.depth, usd, side));
}

/**
 * The pool's gap to the exchange, from its swaps: for each swap, its price against the close of the exchange's
 * hourly candle it falls in. Returns the median gap and the mean absolute deviation around it, or null when too few
 * swaps line up with a candle. `swaps` times are in ms, candle times in seconds.
 */
export function measureBasis(swaps: { time: number; price: number }[], candles: { time: number; close: number }[], hour = 3600): { median: number; mad: number; n: number } | null {
  const gaps: number[] = [];
  for (const s of swaps) {
    const t = s.time / 1000;
    let lo = 0, hi = candles.length - 1, at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (candles[mid].time <= t) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (at < 0 || t - candles[at].time >= hour || !(s.price > 0) || !(candles[at].close > 0)) continue;
    gaps.push(s.price / candles[at].close - 1);
  }
  if (gaps.length < MIN_SWAPS) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { median, mad: gaps.reduce((s, g) => s + Math.abs(g - median), 0) / gaps.length, n: gaps.length };
}
/** The pool's fill model from what could be read: measured when the gap could be measured, the haircut otherwise. */
export function poolModel(depth: PoolState | undefined, gap: { median: number; mad: number; n: number } | null): FillModel {
  return gap ? { source: 'pool', fee: POOL_FEE, slip: gap.mad, basis: gap.median, samples: gap.n, depth, amountUsd: ASSUMED_USD } : haircutModel(depth);
}
