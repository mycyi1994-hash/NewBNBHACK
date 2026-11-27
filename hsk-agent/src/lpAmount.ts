// How much goes where in a liquidity plan, and how its numbers are written. Pure: the studio and its tests share it.
import type { Goal } from './lp.ts';

export interface Wallet { usdt: number; coin: number }

/** Rounds down to `d` decimals without float dust (0.29 × 100 is 28.999…). */
export const floorTo = (v: number, d: number) => {
  if (!(v > 0)) return 0;
  const k = 10 ** d;
  return Math.floor(Number((v * k).toPrecision(12))) / k;
};

/** The most a goal can put in, in dollars: buying uses the USDT, selling the coin, both uses both. */
export function maxUsd(goal: Goal, w: Wallet, price: number): number {
  const u = floorTo(w.usdt, 2), c = w.coin * price;
  return goal === 'buy' ? u : goal === 'sell' ? floorTo(c, 2) : floorTo(u + c, 2);
}

export interface Split {
  /** USDT under the price, and the coin over it (whole units). */
  usdt: number; coin: number;
  /** The coin side in dollars. */
  coinUsd: number;
  /** Goal 'both': the side that had less than half, and the dollars that went to the other side instead. */
  short?: 'usdt' | 'coin'; moved: number;
}

/**
 * Splits a dollar amount between the two sides. 'both' puts half on each; with a wallet, a side that holds less than
 * its half gets all it has and the rest goes to the other side, so the amount asked for is the amount supplied.
 * No side is ever given more than the wallet holds (a total beyond the wallet still shows as more than it holds).
 */
export function allocate(goal: Goal, totalUsd: number, price: number, w: Wallet | null, decimals: number): Split {
  const total = floorTo(totalUsd, 2), dp = Math.min(decimals, 12);
  const coinOf = (usd: number) => {
    const c = floorTo(usd / price, dp);
    // "All" of the coin: the float division can land a hair over the balance.
    return w && c > w.coin ? w.coin : c;
  };
  if (!(total > 0) || !(price > 0)) return { usdt: 0, coin: 0, coinUsd: 0, moved: 0 };
  if (goal === 'buy') return { usdt: total, coin: 0, coinUsd: 0, moved: 0 };
  if (goal === 'sell') { const coin = coinOf(total); return { usdt: 0, coin, coinUsd: coin * price, moved: 0 }; }
  let u = total / 2, c = total / 2, short: Split['short'], moved = 0;
  if (w) {
    const hasU = floorTo(w.usdt, 2), hasC = w.coin * price;
    if (c > hasC && u < hasU) { moved = Math.min(c - hasC, hasU - u); c = hasC; u += moved; short = 'coin'; }
    else if (u > hasU && c < hasC) { moved = Math.min(u - hasU, hasC - c); u = hasU; c += moved; short = 'usdt'; }
  }
  const usdt = floorTo(u, 2), coin = coinOf(c);
  return { usdt, coin, coinUsd: coin * price, short, moved: floorTo(moved, 2) };
}

/** Dollars: cents below $10,000, whole dollars above, and never a bare "$0.00" for something that is there. */
export function money(v: number): string {
  if (!(v > 0)) return '$0';
  if (v < 0.01) return '<$0.01';
  if (v >= 10_000) return `$${Math.round(v).toLocaleString('en-US')}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A coin amount with three significant digits, never in exponent form (0.00000422 rather than 4.22e-6). */
export function coinQty(v: number): string {
  if (!(v > 0)) return '0';
  if (v >= 1000) return Math.round(v).toLocaleString('en-US');
  if (v >= 1) return Number(v.toFixed(4)).toString();
  const d = Math.min(12, Math.ceil(-Math.log10(v)) + 2);
  return v.toFixed(d).replace(/0+$/, '').replace(/\.$/, '');
}

/** A price: whole dollars from $1,000, cents from $1, four significant digits under that. */
export function priceText(v: number): string {
  if (v >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${Number(v.toPrecision(4))}`;
}

/** A side worth less than this is too small to earn anything worth the gas; the studio says so. */
export const SMALL_SIDE_USD = 1;

/** The plan's part of the liquidity in a band, from the USDT it takes to move the price through it before and after. */
export function shareOf(before: number, after: number): number | null {
  if (!(after > 0) || !(after >= before)) return null;
  return (after - before) / after;
}

export const pctText = (x: number) => (x <= 0 ? '0%' : x < 0.001 ? '<0.1%' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);

/**
 * If the price goes through every step of one side: what it all turns into and the average price of that trade.
 * A Uniswap V3 range from pa to pb converts at an average of √(pa·pb). Steps are given in prices (USDT per coin);
 * `amount` is USDT for the buying side and the coin for the selling side. The fees earned on the way are not counted.
 */
export function fullFill(steps: { lo: number; hi: number; amount: number }[], side: 'buy' | 'sell'): { got: number; avg: number; spent: number } | null {
  let got = 0, spent = 0;
  for (const s of steps) {
    if (!(s.amount > 0) || !(s.lo > 0) || !(s.hi > s.lo)) continue;
    const mid = Math.sqrt(s.lo * s.hi);
    spent += s.amount;
    got += side === 'buy' ? s.amount / mid : s.amount * mid;
  }
  if (!(got > 0)) return null;
  return { got, spent, avg: side === 'buy' ? spent / got : got / spent };
}

/**
 * What the plan holds if the price moves to `p`: each step is a Uniswap V3 range from `lo` to `hi`; a buying step starts
 * as `amount` USDT (the price above it), a selling step as `amount` of the coin (the price under it). Fees not counted.
 */
export function holdingsAt(steps: { lo: number; hi: number; amount: number; side: 'buy' | 'sell' }[], p: number): { usdt: number; coin: number; worth: number } {
  let usdt = 0, coin = 0;
  const q = Math.sqrt(p);
  for (const s of steps) {
    if (!(s.amount > 0) || !(s.lo > 0) || !(s.hi > s.lo)) continue;
    const a = Math.sqrt(s.lo), b = Math.sqrt(s.hi), x = Math.min(Math.max(q, a), b);
    const L = s.side === 'buy' ? s.amount / (b - a) : s.amount / (1 / a - 1 / b);
    usdt += L * (x - a);
    coin += L * (1 / x - 1 / b);
  }
  return { usdt, coin, worth: usdt + coin * p };
}
