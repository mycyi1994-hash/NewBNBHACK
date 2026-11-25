import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCollect, scorePosition, FEE_HASHKEY, FEE_HSKSWAP, type Agent } from './agents.ts';
import { recommend } from './recommend.ts';
import { MARKETS } from './cex.ts';

const DAY = 86_400;
/** Daily candles from a close series (open = previous close, high/low around it). */
const bars = (closes: number[]) => closes.map((c, i) => ({ time: 1_700_000_000 + i * DAY, open: closes[i - 1] ?? c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 }));
const rising = (n: number) => Array.from({ length: n }, (_, i) => 100 * 1.003 ** i);
const market = (s: string) => MARKETS.find((m) => m.symbol === s)!;

test('position agents pay the HSKSwap fee only when they can trade there', () => {
  const b = bars(rising(300));
  const btc = scorePosition('trend', market('BTCUSDT-PERPETUAL'), b)!;
  const sol = scorePosition('trend', market('SOLUSDT'), b)!;
  assert.equal(btc.runnable, true);
  assert.equal(btc.fee, FEE_HSKSWAP);
  assert.equal(sol.runnable, false);
  assert.equal(sol.fee, FEE_HASHKEY);
  assert.equal(btc.live, true, 'a steady rise keeps the trend agent long');
  assert.ok(btc.total < sol.total, 'the higher fee costs return on the same candles');
  assert.equal(btc.id, 'trend-BTCUSDT-PERPETUAL');
});

test('a daily collect agent buys every day; the trend filter skips days under the 50-day average', () => {
  const up = scoreCollect('daily', 'HSK', bars(rising(300)))!;
  assert.equal(up.trades, up.days);
  assert.equal(up.mult, 1);
  assert.ok(up.total > 0);
  const down = Array.from({ length: 300 }, (_, i) => 100 * 0.997 ** i);
  const tf = scoreCollect('trendDca', 'HSK', bars(down))!;
  assert.equal(tf.trades, 0, 'never above its 50-day average while falling');
  assert.equal(tf.live, false);
  assert.equal(tf.mult, 0);
});

const fake = (p: Partial<Agent>): Agent => ({
  id: 'x', kind: 'position', rule: 'trend', style: 'trend', risk: 2, base: 'BTC', runnable: true, source: 'hashkey', fee: 0.003,
  days: 100, from: 0, to: 0, total: 0, hold: 0, maxDd: 0.2, sharpe: 0, trades: 1, inMarket: 0.5, equity: [], live: false, mult: 0, price: 1, ...p,
});

test('recommend: runnable only, the coin asked for, the risk the level allows, smallest worst drop', () => {
  const agents = [
    fake({ id: 'boll-SOL', rule: 'boll', base: 'SOL', runnable: false, maxDd: 0.01, risk: 1 }),
    fake({ id: 'break-ETH', rule: 'break', base: 'ETH', maxDd: 0.05, risk: 3 }),
    fake({ id: 'trend-ETH', rule: 'trend', base: 'ETH', maxDd: 0.12, risk: 2 }),
    fake({ id: 'boll-ETH', rule: 'boll', base: 'ETH', maxDd: 0.09, risk: 1 }),
    fake({ id: 'daily-ETH', rule: 'daily', kind: 'collect', base: 'ETH', maxDd: 0.3, risk: 1 }),
    fake({ id: 'trend-BTC', rule: 'trend', base: 'BTC', maxDd: 0.02, risk: 2 }),
  ];
  const pro = recommend(agents, { coin: 'ETH', level: 'pro' })!;
  assert.equal(pro.pick.id, 'break-ETH');
  assert.equal(pro.scope, 'coin');
  const newbie = recommend(agents, { coin: 'ETH', level: 'new' })!;
  assert.equal(newbie.pick.id, 'boll-ETH', 'risk 3 is left out for a first-timer');
  assert.deepEqual(newbie.others.map((a) => a.id), ['trend-ETH', 'daily-ETH']);
  const sol = recommend(agents, { coin: 'SOL', level: 'some' })!;
  assert.equal(sol.scope, 'all', 'no runnable SOL agent, so every runnable agent is in scope');
  assert.equal(sol.pick.id, 'trend-BTC');
  assert.equal(recommend([fake({ runnable: false })]), null);
});
