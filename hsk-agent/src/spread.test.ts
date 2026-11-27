import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolState } from './depth.ts';
import { breakEven, buySlip, costBand, gapStats, hunterAgent, hunterRun, hunterState, POOL_FEE, roundTrip, sellImpact, sellSlip, spreadBrief, spreadOf, TAKER_FEE, type GapPoint } from './spread.ts';

// A full-range pool: 40,000 USDT and the same value of the coin at a raw price of 4 (as in depth.test.ts).
const flat: PoolState = { sqrtPrice: 2, tick: 13_863, liquidity: 40_000e6 / 2, ticks: [] };

test('a sale moves the price down by what the pool math says, and more for more', () => {
  // Selling coin worth $400 (1% of the USDT side) into a full-range pool of $40k a side moves the price about 2%.
  const m = sellImpact(flat, 400);
  assert.ok(m > 0.019 && m < 0.021, String(m));
  assert.ok(sellImpact(flat, 10) < sellImpact(flat, 100));
  // The average price paid is about half of the move.
  assert.ok(Math.abs(sellSlip(flat, 400) - (1 - Math.sqrt(1 - m))) < 1e-12);
  assert.ok(buySlip(flat, 400) > 0 && buySlip(flat, 400) < 0.011);
});

test('the net edge is the gross gap minus the pool fee, the taker fee and the slip, and falls with size', () => {
  // The pool 2% under the exchange: buy on HSKSwap, sell on the exchange.
  const s = spreadOf({ asset: 'BTC', pool: 98, exchange: 100, venue: 'HashKey Global', state: flat });
  assert.equal(s.side, 'poolCheap');
  assert.ok(Math.abs(s.gross - (100 / 98 - 1)) < 1e-12);
  assert.equal(s.fees, POOL_FEE + TAKER_FEE);
  const [n10, n100, n1000] = s.sizes.map((z) => z.net);
  assert.ok(Math.abs(n10 - (s.gross - s.fees - buySlip(flat, 10))) < 1e-12);
  assert.ok(n10 > n100 && n100 > n1000);
  // break-even: the last size still above zero, and just past it below
  assert.ok(s.breakEven! > 100 && s.breakEven! < 1000, String(s.breakEven));
  const net = (usd: number) => s.gross - s.fees - buySlip(flat, usd);
  assert.ok(net(s.breakEven!) > 0 && net(s.breakEven! * 1.01) < 0);
});

test('a gap smaller than the fees is worth nothing at any size; no depth means no net number', () => {
  const s = spreadOf({ asset: 'ETH', pool: 100.2, exchange: 100, venue: 'Gate', state: flat });
  assert.equal(s.side, 'poolDear');
  assert.equal(s.breakEven, 0);
  assert.ok(s.sizes.every((z) => z.net < 0));
  const blind = spreadOf({ asset: 'ETH', pool: 100.2, exchange: 100, venue: 'Gate' });
  assert.equal(blind.breakEven, undefined);
  assert.ok(blind.sizes.every((z) => Number.isNaN(z.net)));
  assert.equal(breakEven(() => -1), 0);
  assert.equal(breakEven(() => 1, 1000), 1000);
});

const H = 3_600_000, T0 = Date.UTC(2026, 0, 1);
/** A day and a half of 5-minute records: the pool at the exchange, a 2% discount for an hour, then back. */
function day(dip = -0.02): GapPoint[] {
  const out: GapPoint[] = [];
  for (let k = 0; k < 36 * 12; k++) {
    const t = T0 + k * 5 * 60_000, ex = 100, inDip = t >= T0 + 10 * H && t < T0 + 11 * H;
    out.push({ t, pool: ex * (1 + (inDip ? dip : 0)), hk: ex, buy: 0.001, sell: 0.001 });
  }
  return out;
}

test('the cost band and the round trip come from the recorded slip', () => {
  assert.deepEqual(costBand({ buy: 0.001, sell: 0.002 }), [-(0.003 + 0.001 + 0.001), 0.003 + 0.001 + 0.002]);
  assert.equal(roundTrip({ buy: 0.001, sell: 0.001 }), 0.008);
  const st = gapStats(day());
  assert.equal(st.outside, 12);
  assert.ok(Math.abs(st.widest + 0.02) < 1e-12);
});

test('the hunter buys a discount bigger than a round trip and sells when it closes, priced with fees and slip', () => {
  const r = hunterRun(day());
  assert.equal(r.trades, 1);
  assert.deepEqual(r.marks.map((m) => m.side), ['buy', 'sell']);
  assert.equal(r.holding, false);
  // bought at 98 × 1.001 after the fee, sold at 100 × 0.999 less the fee
  const expect = ((1 - POOL_FEE) / (98 * 1.001)) * 100 * 0.999 * (1 - POOL_FEE);
  assert.ok(Math.abs(r.equity[r.equity.length - 1].value - expect) < 1e-12);
  // a discount smaller than the round trip is left alone
  assert.equal(hunterRun(day(-0.005)).trades, 0);
});

test('with less than a day of records the hunter says it is still recording and shows no result', () => {
  const short = day().slice(0, 50);
  assert.deepEqual(hunterState(short), { building: true, points: 50, spanMs: 49 * 5 * 60_000 });
  const a = hunterAgent('BTC', short);
  assert.equal(a.id, 'spread-BTC');
  assert.equal(a.total, 0);
  assert.equal(a.equity.length, 0);
  assert.equal(hunterState(day()).building, false);
  const full = hunterAgent('BTC', day());
  assert.ok(full.total > 0 && full.live === false && full.kind === 'position');
  // no records at all: out of the market, nothing to buy
  assert.equal(hunterAgent('ETH', []).live, false);
});

test('the brief says plainly whether any gap beats the costs', () => {
  const cheap = spreadOf({ asset: 'BTC', pool: 98, exchange: 100, venue: 'HashKey Global', state: flat });
  const flatGap = spreadOf({ asset: 'ETH', pool: 100.1, exchange: 100, venue: 'HashKey Global', state: flat });
  assert.match(spreadBrief([cheap, flatGap], 'ko'), /^비용을 넘는 차이가 있어요/);
  assert.match(spreadBrief([flatGap], 'en'), /^No gap beats the costs/);
  assert.match(spreadBrief([], 'ko'), /읽지 못했어요/);
});
