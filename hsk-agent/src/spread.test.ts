import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolState } from './depth.ts';
import { breakEven, buySlip, costBand, gapStats, hunterAgent, hunterRun, hunterState, MAX_HOLD_MS, POOL_FEE, roundTrip, sellImpact, sellSlip, spreadBrief, spreadOf, TAKER_FEE, type GapPoint } from './spread.ts';

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
/** 5-minute records of a pool against an exchange at 100; `pool(t)` gives the pool price at hour t. */
function rec(hours: number, pool: (h: number) => number, ex: (h: number) => number = () => 100): GapPoint[] {
  const out: GapPoint[] = [];
  for (let k = 0; k <= hours * 12; k++) { const h = k / 12; out.push({ t: T0 + h * H, pool: pool(h), hk: ex(h), buy: 0.001, sell: 0.001 }); }
  return out;
}
/** A day and a half: at the exchange, a 2% discount for an hour at hour 10 and again at hour 20, closing each time. */
const day = (dip = -0.02) => rec(36, (h) => 100 * (1 + ((h >= 10 && h < 11) || (h >= 20 && h < 21) ? dip : 0)));

test('the cost band and the round trip come from the recorded slip', () => {
  assert.deepEqual(costBand({ buy: 0.001, sell: 0.002 }), [-(0.003 + 0.001 + 0.001), 0.003 + 0.001 + 0.002]);
  assert.equal(roundTrip({ buy: 0.001, sell: 0.001 }), 0.008);
  const st = gapStats(day());
  assert.equal(st.outside, 24);
  assert.ok(Math.abs(st.widest + 0.02) < 1e-12);
});

test('the hunter waits until the record shows the pool closing a discount, then buys the next one and sells it at the target', () => {
  const r = hunterRun(day());
  // the first dip only proves the pool reverts; the second is bought
  assert.equal(r.trades, 1);
  assert.equal(r.marks[0].time, Math.floor((T0 + 20 * H) / 1000));
  assert.deepEqual(r.exits, ['target']);
  assert.equal(r.holding, false);
  // bought at 98 × 1.001 after the fee, sold at 100 × 0.999 less the fee
  const expect = ((1 - POOL_FEE) / (98 * 1.001)) * 100 * 0.999 * (1 - POOL_FEE);
  assert.ok(Math.abs(r.equity[r.equity.length - 1].value - expect) < 1e-12);
  // a discount smaller than the round trip is left alone
  assert.equal(hunterRun(day(-0.005)).trades, 0);
});

test('a pool whose price never moves never qualifies, however wide the gap', () => {
  const stale = rec(48, () => 98, (h) => 100 + (h % 2));
  const r = hunterRun(stale);
  assert.equal(r.reverted, false);
  assert.equal(r.trades, 0);
});

test('a discount that does not close is sold after the time limit, a falling pool on the stop', () => {
  // reverts once at hour 2, then sits 2% under the exchange for four days
  const flat = rec(4 * 24 + 6, (h) => (h >= 1 && h < 2 ? 98 : h < 3 ? 100 : 98));
  const r = hunterRun(flat);
  assert.equal(r.trades, 2);
  assert.equal(r.exits[0], 'time');
  assert.ok(r.marks[1].time - r.marks[0].time >= MAX_HOLD_MS / 1000);
  // after a buy at 98 the pool falls 6%: out on the stop
  const fall = rec(12, (h) => (h >= 1 && h < 2 ? 98 : h < 3 ? 100 : h < 4 ? 98 : 98 * 0.94), (h) => (h < 4 ? 100 : 100 * 0.94 * 1.03));
  assert.deepEqual(hunterRun(fall).exits, ['stop']);
});

test('with less than a day of records the hunter says it is still recording, shows no result, and cannot be hired', () => {
  const short = day().slice(0, 50);
  assert.deepEqual(hunterState(short), { building: true, points: 50, spanMs: 49 * 5 * 60_000 });
  const a = hunterAgent('BTC', short);
  assert.equal(a.id, 'spread-BTC');
  assert.equal(a.total, 0);
  assert.equal(a.equity.length, 0);
  assert.equal(a.runnable, false);
  assert.equal(hunterState(day()).building, false);
  const full = hunterAgent('BTC', day());
  assert.ok(full.total > 0 && full.live === false && full.kind === 'position' && full.runnable);
  // no records at all: out of the market, nothing to buy
  assert.equal(hunterAgent('ETH', []).live, false);
});

test('the brief says yes only for a trade the vault can make, and says what it cannot', () => {
  const cheap = spreadOf({ asset: 'BTC', pool: 98, exchange: 100, venue: 'HashKey Global', state: flat });
  const dear = spreadOf({ asset: 'ETH', pool: 100.1, exchange: 100, venue: 'HashKey Global', state: flat });
  assert.ok(cheap.vaultNet! > 0 && Math.abs(cheap.vaultNet! - (cheap.gross - cheap.roundTrip!)) < 1e-12);
  assert.equal(dear.vaultNet, undefined);
  assert.match(spreadBrief([{ s: cheap, reverted: true }, { s: dear, reverted: true }], 'ko'), /^있어요: BTC를 HSKSwap에서/);
  // the same gap on a pool that has never closed one: no
  const no = spreadBrief([{ s: cheap, reverted: false }], 'ko');
  assert.match(no, /^지금은 볼트로 할 수 있는 차익이 없어요/);
  assert.match(no, /할인을 닫은 기록이 아직 없어요/);
  assert.match(no, /거래소에서 팔 수 있을 때만/);
  assert.match(spreadBrief([{ s: dear, reverted: true }], 'en'), /^Nothing your vault can act on/);
  assert.match(spreadBrief([], 'ko'), /읽지 못했어요/);
});
