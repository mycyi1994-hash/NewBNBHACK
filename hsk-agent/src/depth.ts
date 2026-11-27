// How deep an HSKSwap pool is, from its own numbers on chain: the price, the liquidity in range, and the ticks
// where liquidity starts or ends. From those: how much USDT it takes to move the price by 1%, 2%, 5%, and how
// far an order of a given size moves it. USDT is token1 in all three pools, so the raw price is USDT per coin.

/** One initialized tick near the price: crossing it upward adds `net` to the liquidity in range. */
export interface PoolTick { tick: number; net: number }
export interface PoolState { sqrtPrice: number; tick: number; liquidity: number; ticks: PoolTick[] }
/** USDT that moves the price this far: paid in for a move up, paid out for a move down. */
export interface DepthBand { pct: number; usdt: number }
/**
 * What the pool holds in one stretch of prices (`from` and `to` are multiples of the price now). Under the price
 * that is USDT waiting to buy; over it, the coin waiting to be sold, given at what a buyer pays for it in USDT.
 */
export interface RangeBin { from: number; to: number; usd: number; side: 'usdt' | 'coin' }
export interface PoolDepth { bands: DepthBand[]; impact: { usd: number; pct: number }[]; range: RangeBin[] }

const FEE = 0.003;
export const DEPTH_STEPS = [1, 2, 5] as const;
export const IMPACT_SIZES = [10, 100, 1000] as const;
const sqrtAt = (tick: number) => Math.pow(1.0001, tick / 2);

/** USDT (in whole units) between two prices, walking the ticks in between. `to` is a multiple of the current price. */
function usdtToMove(p: PoolState, to: number): number {
  const target = p.sqrtPrice * Math.sqrt(to), up = to > 1;
  const ticks = p.ticks.filter((t) => (up ? t.tick > p.tick : t.tick <= p.tick)).sort((a, b) => (up ? a.tick - b.tick : b.tick - a.tick));
  let at = p.sqrtPrice, L = p.liquidity, raw = 0;
  for (const t of ticks) {
    const edge = sqrtAt(t.tick);
    if (up ? edge >= target : edge <= target) break;
    raw += L * Math.abs(edge - at);
    at = edge;
    L += up ? t.net : -t.net;
  }
  raw += L * Math.abs(target - at);
  return raw / 1e6;
}

/** How far a buy of `usd` USDT moves the price up (0.01 = 1%), after the pool's fee. */
export function buyImpact(p: PoolState, usd: number): number {
  let left = usd * (1 - FEE) * 1e6, at = p.sqrtPrice, L = p.liquidity;
  for (const t of p.ticks.filter((x) => x.tick > p.tick).sort((a, b) => a.tick - b.tick)) {
    const edge = sqrtAt(t.tick), need = L * (edge - at);
    if (L <= 0 || need >= left) break;
    left -= need; at = edge; L += t.net;
  }
  if (L <= 0) return Infinity;
  at += left / L;
  return (at / p.sqrtPrice) ** 2 - 1;
}

export function poolDepth(p: PoolState): PoolDepth {
  const bands: DepthBand[] = [];
  for (const s of [...DEPTH_STEPS].reverse()) bands.push({ pct: -s, usdt: usdtToMove(p, 1 - s / 100) });
  // A move up is paid for by the buyer, fee included.
  for (const s of DEPTH_STEPS) bands.push({ pct: s, usdt: usdtToMove(p, 1 + s / 100) / (1 - FEE) });
  return { bands, impact: IMPACT_SIZES.map((usd) => ({ usd, pct: buyImpact(p, usd) })), range: rangeBins(p) };
}

/** The pool's holdings in equal steps of price, `perSide` steps under the price and as many over it, out to `reachPct` percent. */
export function rangeBins(p: PoolState, reachPct = 10, perSide = 10): RangeBin[] {
  const step = reachPct / 100 / perSide, out: RangeBin[] = [];
  for (let i = perSide; i >= 1; i--) out.push({ from: 1 - i * step, to: 1 - (i - 1) * step, usd: usdtToMove(p, 1 - i * step) - usdtToMove(p, 1 - (i - 1) * step), side: 'usdt' });
  for (let i = 1; i <= perSide; i++) out.push({ from: 1 + (i - 1) * step, to: 1 + i * step, usd: usdtToMove(p, 1 + i * step) - usdtToMove(p, 1 + (i - 1) * step), side: 'coin' });
  return out;
}
