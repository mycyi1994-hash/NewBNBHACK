import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCollect, scorePosition, positions, overlays, FEE_HASHKEY, FEE_HSKSWAP, POSITION_RULES, PROOF, TIER, type Agent } from './agents.ts';
import { recommend } from './recommend.ts';
import { LEAD_DAYS, replayDays } from './replay.ts';
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

test('the backtest records what it did: entries and exits for a position agent, every buy for a collect agent', () => {
  // up, then down under the 50-day average, then up again: the trend agent goes in, out, and in.
  const wave = [...rising(120), ...Array.from({ length: 80 }, (_, i) => 100 * 1.003 ** 119 * 0.99 ** (i + 1)), ...Array.from({ length: 120 }, (_, i) => 60 * 1.01 ** i)];
  const a = scorePosition('trend', market('BTCUSDT-PERPETUAL'), bars(wave))!;
  assert.equal(a.marks.filter((m) => m.side === 'buy').length, a.trades, 'one buy mark per entry');
  assert.ok(a.marks.some((m) => m.side === 'sell' && typeof m.ret === 'number'), 'an exit carries the round trip return');
  for (let i = 1; i < a.marks.length; i++) assert.notEqual(a.marks[i].side, a.marks[i - 1].side, 'buys and sells alternate');
  assert.equal(a.bench.length, a.equity.length, 'the hold line covers the same days');
  assert.ok(Math.abs(a.bench[a.bench.length - 1].value - 1 - a.hold) < 1e-9);
  const c = scoreCollect('rsiDca', 'HSK', bars(wave))!;
  assert.equal(c.marks.length, c.trades);
  assert.ok(c.marks.every((m) => m.side === 'buy' && (m.mult ?? 0) > 0));
});

test('the published classics decide the way their sources say, and are left out without enough history', () => {
  const b = bars([...rising(500), ...Array.from({ length: 300 }, (_, i) => 100 * 1.003 ** 499 * 0.995 ** (i + 1))]);
  const mom = positions('tsmom', b), c = b.map((x) => x.close);
  for (const i of [364, 365, 500, 700, 799]) assert.equal(mom[i], i >= 365 && c[i] > c[i - 365], `12-month momentum at day ${i}`);
  assert.equal(positions('trend200', b)[150], false, 'no 200-day average yet');
  assert.equal(positions('golden', b)[450], true, 'the 50-day average is above the 200-day in a steady rise');
  assert.equal(scorePosition('tsmom', market('BTCUSDT-PERPETUAL'), bars(rising(500))), null, '500 days leave too little to test after 365 of look-back');
  const full = scorePosition('tsmom', market('BTCUSDT-PERPETUAL'), b)!;
  assert.equal(full.days, 800 - 1 - 365, 'a younger market is scored over what it has after the warm-up');
  assert.equal(full.tier, 1);
  assert.equal(full.seam, undefined, 'no join when every day is the exchange\'s own');
  assert.equal(scorePosition('tsmom', market('BTCUSDT-PERPETUAL'), b, 365)!.days, 365, 'a shorter window on request');
  assert.equal(scorePosition('trend', market('BTCUSDT-PERPETUAL'), bars(rising(2000)))!.days, 1095, 'three years when there is enough history');
  assert.deepEqual([TIER.break, TIER.trend, TIER.smart], [1, 2, 3]);
});

test('an agent that never traded in the window does not outrank one that did', () => {
  const agents = [fake({ id: 'golden-HSK', rule: 'golden', base: 'HSK', maxDd: 0, trades: 0, tier: 1 }), fake({ id: 'break-HSK', rule: 'break', base: 'HSK', maxDd: 0.3, trades: 4, tier: 1 })];
  assert.equal(recommend(agents, { coin: 'HSK', level: 'pro' })!.pick.id, 'break-HSK');
});

test('recommend puts a published classic before an indicator rule, even with a larger worst drop', () => {
  const agents = [fake({ id: 'boll-ETH', rule: 'boll', base: 'ETH', maxDd: 0.05, tier: 2, risk: 1 }), fake({ id: 'trend200-ETH', rule: 'trend200', base: 'ETH', maxDd: 0.2, tier: 1 })];
  assert.equal(recommend(agents, { coin: 'ETH', level: 'new' })!.pick.id, 'trend200-ETH');
});

test('a replay covers the lead-in and every day of the backtest, one daily candle at a time', () => {
  const a = scorePosition('trend', market('BTCUSDT-PERPETUAL'), bars(rising(400)))!;
  const days = replayDays(a);
  assert.equal(days[0], a.from - LEAD_DAYS * DAY);
  assert.equal(days[days.length - 1], a.to);
  assert.equal(days.length, a.days + LEAD_DAYS + 1);
  assert.ok(days.every((d, i) => i === 0 || d - days[i - 1] === DAY));
});

test('every rule decides on past days only and comes with its origin, proof level and chart lines', () => {
  const wave = Array.from({ length: 900 }, (_, i) => 100 * (1 + 0.5 * Math.sin(i / 37)) * 1.001 ** i);
  const b = bars(wave);
  for (const r of POSITION_RULES) {
    const all = positions(r.id, b), cut = positions(r.id, b.slice(0, 700));
    assert.deepEqual(all.slice(0, 700), cut, `${r.id} must not change its past when later days arrive`);
    assert.ok(all.some(Boolean) && !all.every(Boolean), `${r.id} should be in and out on a wave`);
    assert.ok(TIER[r.id] >= 1 && PROOF[r.id], `${r.id} has a tier and a proof level`);
    for (const o of overlays(r.id, b)) assert.equal(o.values.length, b.length);
  }
  assert.equal(POSITION_RULES.filter((r) => TIER[r.id] === 1).length + 1, 20, 'twenty published strategies: nineteen position rules and plain DCA');
  // Dual momentum stays out while the other coin is stronger over the same year.
  const strong = bars(wave.map((v, i) => v * 1.002 ** i));
  assert.ok(positions('dualMom', b, strong).filter(Boolean).length < positions('dualMom', b).filter(Boolean).length);
});

const fake = (p: Partial<Agent>): Agent => ({
  id: 'x', kind: 'position', rule: 'trend', style: 'trend', risk: 2, tier: 2, base: 'BTC', runnable: true, source: 'hashkey', fee: 0.003,
  days: 100, from: 0, to: 0, total: 0, hold: 0, maxDd: 0.2, sharpe: 0, trades: 1, inMarket: 0.5, equity: [], bench: [], marks: [], live: false, mult: 0, price: 1, ...p,
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
