// Ready-made liquidity strategies and a replay of each on past candles.
// A strategy only picks the goal, the shape and how far the blocks reach; the amount stays the user's.
// The replay walks every candle through its open, high, low and close and moves each block the way a
// Uniswap V3 position moves: the swapper's input is what the block takes in, and 0.3% of it is the fee.
// That fee comes from the user's own blocks being crossed, so it needs no pool volume history.
// HSKSwap only follows the exchange when the gap pays for the fee: an arbitrage moves the pool once the
// exchange price is more than 0.3% away, and only up to that edge, so small wiggles earn nothing here.
import { binsOf, tickAt, priceAt, type Goal, type LpPlan, type Shape } from './lp.ts';
import { widthFor } from './lpTalk.ts';

export type LpStrategyId = 'slowBuy' | 'dipLadder' | 'crashCatcher' | 'takeProfit' | 'rangeFees' | 'wideGrid';
export interface LpStrategy { id: LpStrategyId; goal: Goal; shape: Exclude<Shape, 'custom'>; reachPct: number }

/** In the order a beginner should see them: buying first, then selling, then both ways. */
export const LP_STRATEGIES: readonly LpStrategy[] = [
  { id: 'slowBuy', goal: 'buy', shape: 'spot', reachPct: 8 },
  { id: 'dipLadder', goal: 'buy', shape: 'bidask', reachPct: 15 },
  { id: 'crashCatcher', goal: 'buy', shape: 'bidask', reachPct: 30 },
  { id: 'takeProfit', goal: 'sell', shape: 'spot', reachPct: 15 },
  { id: 'rangeFees', goal: 'both', shape: 'curve', reachPct: 4 },
  { id: 'wideGrid', goal: 'both', shape: 'spot', reachPct: 20 },
];

/** The plan fields a strategy sets; amounts are left as they are. */
export const strategyPlan = (s: LpStrategy): { goal: Goal; shape: Exclude<Shape, 'custom'>; step: number; perSide: number; reachPct: number } =>
  ({ goal: s.goal, shape: s.shape, reachPct: s.reachPct, ...widthFor(s.reachPct) });

export interface Candle { time: number; open: number; high: number; low: number; close: number }
export const FEE_RATE = 0.003;

export interface Replay {
  from: number; to: number; candles: number;
  startPrice: number; endPrice: number;
  /** what was put in, at the start price */
  startValue: number;
  /** what the blocks hold at the end, at the end price, fees included */
  endValue: number;
  /** the same coins and USDT left untouched, at the end price */
  holdValue: number;
  /** everything put into the coin at the start price instead */
  allCoinValue: number;
  feeValue: number;
  /** blocks that turned fully into the coin / fully back into USDT */
  buys: number; sells: number;
  endUsdt: number; endCoin: number;
}

/**
 * Replays `plan` (its goal, shape and width) on `candles`, starting at the first candle's open with `value`
 * dollars: all USDT to buy, all coin to sell, half and half for both. Prices are plain USDT per coin.
 */
export function replay(plan: Pick<LpPlan, 'goal' | 'shape' | 'step' | 'perSide' | 'weights'>, candles: Candle[], value = 1000): Replay | null {
  if (candles.length < 2) return null;
  const p0 = candles[0].open;
  if (!(p0 > 0)) return null;
  const goal = plan.goal ?? 'both';
  const usdt = goal === 'sell' ? 0 : goal === 'buy' ? value : value / 2;
  const coin = goal === 'buy' ? 0 : (goal === 'sell' ? value : value / 2) / p0;
  const bins = binsOf({ asset: 'BTC', usdt, coin, shape: plan.shape, step: plan.step, perSide: plan.perSide, weights: plan.weights }, tickAt(p0, 6));

  const blocks = bins.filter((b) => b.amount > 0).map((b) => {
    const sa = Math.sqrt(priceAt(b.lower, 6)), sb = Math.sqrt(priceAt(b.upper, 6));
    const L = b.side === 'usdt' ? b.amount / (sb - sa) : b.amount / (1 / sa - 1 / sb);
    return { sa, sb, L, full: b.side };   // which token it is entirely in right now
  });
  const at = (k: (typeof blocks)[number], s: number): [number, number] => {
    if (s <= k.sa) return [k.L * (1 / k.sa - 1 / k.sb), 0];
    if (s >= k.sb) return [0, k.L * (k.sb - k.sa)];
    return [k.L * (1 / s - 1 / k.sb), k.L * (s - k.sa)];
  };

  let s = Math.sqrt(p0), feeCoin = 0, feeUsdt = 0, buys = 0, sells = 0;
  const moveTo = (p: number) => {
    const s2 = Math.sqrt(p);
    if (s2 === s) return;
    for (const k of blocks) {
      const [x1, y1] = at(k, s), [x2, y2] = at(k, s2);
      if (s2 < s) feeCoin += Math.max(0, x2 - x1) * FEE_RATE;   // falling: swappers pay in the coin
      else feeUsdt += Math.max(0, y2 - y1) * FEE_RATE;          // rising: swappers pay in USDT
      if (s2 <= k.sa && k.full !== 'coin') { if (k.full === 'usdt') buys++; k.full = 'coin'; }
      else if (s2 >= k.sb && k.full !== 'usdt') { if (k.full === 'coin') sells++; k.full = 'usdt'; }
    }
    s = s2;
  };
  let pool = p0;
  const follow = (p: number) => {
    if (!(p > 0)) return;
    if (p > pool * (1 + FEE_RATE)) pool = p / (1 + FEE_RATE);
    else if (p < pool * (1 - FEE_RATE)) pool = p / (1 - FEE_RATE);
    else return;
    moveTo(pool);
  };
  candles.forEach((c, i) => {
    const path = c.close >= c.open ? [c.low, c.high, c.close] : [c.high, c.low, c.close];
    if (i > 0) follow(c.open);
    for (const p of path) follow(p);
  });

  const pEnd = candles[candles.length - 1].close;
  let endCoin = 0, endUsdt = 0;
  for (const k of blocks) { const [x, y] = at(k, s); endCoin += x; endUsdt += y; }
  const feeValue = feeCoin * pEnd + feeUsdt;
  const put = bins.reduce((a, b) => a + (b.side === 'usdt' ? b.amount : b.amount * p0), 0);
  return {
    from: candles[0].time, to: candles[candles.length - 1].time, candles: candles.length,
    startPrice: p0, endPrice: pEnd,
    startValue: put,
    endValue: endCoin * pEnd + endUsdt + feeValue,
    holdValue: usdt + coin * pEnd,
    allCoinValue: (put / p0) * pEnd,
    feeValue, buys, sells, endUsdt, endCoin,
  };
}
