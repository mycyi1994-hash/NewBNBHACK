import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCollect, scoreMade, scorePosition, positions, overlays, FEE_HASHKEY, FEE_HSKSWAP, POSITION_RULES, PROOF, TIER, type Agent } from './agents.ts';
import { recommend } from './recommend.ts';
import { LEAD_DAYS, replayDays } from './replay.ts';
import { TEMPLATE_IDS, fromTemplate, parse, problems, specPositions } from './spec.ts';
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

test('a made rule is data: the templates reproduce the built-in strategies, and it never looks ahead', () => {
  const wave = Array.from({ length: 900 }, (_, i) => 100 * (1 + 0.5 * Math.sin(i / 37)) * 1.001 ** i);
  const b = bars(wave);
  for (const rule of TEMPLATE_IDS) {
    const spec = fromTemplate(rule)!;
    assert.deepEqual(specPositions(spec, b), positions(rule as Parameters<typeof positions>[0], b), `${rule} as data decides like the built-in rule`);
    assert.deepEqual(specPositions(spec, b).slice(0, 600), specPositions(spec, b.slice(0, 600)), `${rule} as data uses past days only`);
    assert.deepEqual(problems({ ...spec, name: 'x' }), []);
  }
  const made = scoreMade({ id: 'm1', name: 'Mine', market: 'BTCUSDT-PERPETUAL', createdAt: 0, ...fromTemplate('trend200')! }, market('BTCUSDT-PERPETUAL'), b)!;
  const built = scorePosition('trend200', market('BTCUSDT-PERPETUAL'), b)!;
  assert.equal(made.total, built.total, 'same engine, same fees, same number');
  assert.equal(made.tier, 3);
  assert.equal(made.id, 'made:m1');
  assert.ok(problems({ name: '', buy: [], sell: [] }).includes('noBuy'));
  assert.ok(problems({ name: 'x', buy: [{ a: { k: 'price' }, op: 'above', b: { k: 'rsi', n: 14 } }], sell: [] }).includes('scale'), 'a price is not compared with RSI');
});

test('a rule can be read from a sentence, in Korean or English, and says what it could not read', () => {
  const ko = parse('200일선 위에서 RSI가 30 밑이면 사고 55 넘으면 팔아');
  assert.deepEqual(ko.buy, [{ a: { k: 'price' }, op: 'above', b: { k: 'sma', n: 200 } }, { a: { k: 'rsi', n: 14 }, op: 'below', b: { k: 'num', n: 30 } }]);
  assert.deepEqual(ko.sell, [{ a: { k: 'rsi', n: 14 }, op: 'above', b: { k: 'num', n: 55 } }]);
  const en = parse('buy when RSI is under 30, sell when RSI is over 55');
  assert.deepEqual(en.buy, [{ a: { k: 'rsi', n: 14 }, op: 'below', b: { k: 'num', n: 30 } }]);
  assert.deepEqual(en.sell, [{ a: { k: 'rsi', n: 14 }, op: 'above', b: { k: 'num', n: 55 } }]);
  assert.deepEqual(parse('20일 신고가에 사고 10일 신저가에 팔아'), { buy: [{ a: { k: 'price' }, op: 'above', b: { k: 'high', n: 20 } }], sell: [{ a: { k: 'price' }, op: 'below', b: { k: 'low', n: 10 } }], unknown: [] });
  assert.deepEqual(parse('골든크로스에 사고 데드크로스에 팔아').buy, [{ a: { k: 'sma', n: 50 }, op: 'above', b: { k: 'sma', n: 200 } }]);
  assert.deepEqual(parse('4주 전보다 높으면 사고 낮으면 팔아').buy, [{ a: { k: 'ret', n: 28 }, op: 'above', b: { k: 'num', n: 0 } }]);
  assert.equal(parse('기분 좋을 때 사줘').buy.length, 0);
  const chat = parse('20일 신고가에 사고 10일 신저가에 파는 에이전트 만들어줘');
  assert.equal(chat.buy.length, 1); assert.deepEqual(chat.sell, [{ a: { k: 'price' }, op: 'below', b: { k: 'low', n: 10 } }]);
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

test('an agent working now (holding, or traded in the last 30 days) leads one that has sat in cash for months', () => {
  const now = Date.now() / 1000;
  const sleepy = fake({ id: 'trend200-HSK', rule: 'trend200', base: 'HSK', tier: 1, maxDd: 0.1, trades: 3, marks: [{ time: now - 460 * DAY, side: 'sell', price: 1 }] });
  const busy = fake({ id: 'break-HSK', rule: 'break', base: 'HSK', tier: 1, maxDd: 0.4, trades: 9, marks: [{ time: now - 5 * DAY, side: 'buy', price: 1 }] });
  const holding = fake({ id: 'golden-HSK', rule: 'golden', base: 'HSK', tier: 1, maxDd: 0.3, trades: 2, live: true, marks: [{ time: now - 200 * DAY, side: 'buy', price: 1 }] });
  assert.equal(recommend([sleepy, busy], { coin: 'HSK', level: 'pro' })!.pick.id, 'break-HSK');
  assert.equal(recommend([sleepy, busy, holding], { coin: 'HSK', level: 'pro' })!.pick.id, 'golden-HSK', 'holding counts as working');
  assert.equal(recommend([sleepy], { coin: 'HSK', level: 'pro' })!.pick.id, 'trend200-HSK', 'with no working agent the best of the rest still shows');
});

test('recommend skips agents already hired when another fits', () => {
  const now = Date.now() / 1000;
  const a = fake({ id: 'break-BTC', rule: 'break', tier: 1, maxDd: 0.1, live: true });
  const b = fake({ id: 'golden-BTC', rule: 'golden', tier: 1, maxDd: 0.2, marks: [{ time: now - 2 * DAY, side: 'buy', price: 1 }] });
  assert.equal(recommend([a, b], { coin: 'BTC', exclude: ['break-BTC'] })!.pick.id, 'golden-BTC');
  assert.equal(recommend([a], { coin: 'BTC', exclude: ['break-BTC'] })!.pick.id, 'break-BTC', 'nothing else fits, so the hired one is still shown');
});

test('among agents working now, one that beat just holding comes before a steadier one that did not', () => {
  const now = Date.now() / 1000;
  const steadyLoser = fake({ id: 'trend200-BTC', rule: 'trend200', tier: 1, maxDd: 0.1, total: 0.2, hold: 0.6, live: true });
  const winner = fake({ id: 'break-BTC', rule: 'break', tier: 1, maxDd: 0.35, total: 0.9, hold: 0.6, marks: [{ time: now - 3 * DAY, side: 'buy', price: 1 }] });
  assert.equal(recommend([steadyLoser, winner], { coin: 'BTC', level: 'pro' })!.pick.id, 'break-BTC');
});

/* ---------- a made agent on its own candle interval ---------- */

const HOUR = 3_600;
/** Candles of any length from a close series. */
const barsOf = (closes: number[], secs: number) => closes.map((c, i) => ({ time: 1_700_000_000 + i * secs, open: closes[i - 1] ?? c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 }));
/** A wave long enough for an RSI rule to buy and sell several times. */
const wave = (n: number) => Array.from({ length: n }, (_, i) => 100 * (1 + 0.08 * Math.sin(i / 9)) * 1.0002 ** i);

test('a made agent with no interval stays daily: same window, same numbers as before intervals existed', async () => {
  const { intervalOf, WINDOW_DAYS } = await import('./spec.ts');
  const spec = { id: 'd', name: 'D', market: 'BTCUSDT-PERPETUAL', createdAt: 0, ...fromTemplate('rsi')! };
  assert.equal(intervalOf(spec), '1d');
  assert.equal(intervalOf({ interval: '15m' }), '1d', 'an unknown interval is read as daily');
  assert.equal(WINDOW_DAYS['1d'], 1095);
  const b = bars(wave(2000));
  const plain = scoreMade(spec, market('BTCUSDT-PERPETUAL'), b)!;
  const daily = scoreMade({ ...spec, interval: '1d' }, market('BTCUSDT-PERPETUAL'), b)!;
  assert.deepEqual(daily, { ...plain, made: { ...spec, interval: '1d' } });
  assert.equal(plain.interval, undefined, 'a daily agent carries no interval');
  assert.equal(plain.days, 1095);
  assert.equal(plain.total, scorePosition('rsi', market('BTCUSDT-PERPETUAL'), b)!.total, 'still the built-in RSI rule to the cent');
});

test('hourly candles feed the same decision code; the window and its days are counted honestly', async () => {
  const { specPositions: sp, WINDOW_DAYS, PER_DAY } = await import('./spec.ts');
  const spec = { id: 'h', name: 'H', market: 'BTCUSDT-PERPETUAL', createdAt: 0, interval: '1h' as const, ...fromTemplate('rsi')! };
  const b = barsOf(wave(3000), HOUR);
  const a = scoreMade(spec, market('BTCUSDT-PERPETUAL'), b)!;
  assert.equal(a.interval, '1h');
  assert.equal(a.days, WINDOW_DAYS['1h'], 'ninety days of hourly candles');
  assert.equal(a.equity.length, WINDOW_DAYS['1h'] * PER_DAY['1h'] + 1, 'one point per hour of the window');
  assert.equal(a.live, sp(spec, b)[b.length - 1], 'live is the rule on the last candle given');
  // The same closes as daily candles give the same positions: the rule counts candles, whatever their length.
  assert.deepEqual(sp(spec, b), sp(spec, bars(wave(3000))));
  // The interval changes only the clock: the same candles scored as daily cover a different span of days.
  const asDaily = scoreMade({ ...spec, interval: undefined }, market('BTCUSDT-PERPETUAL'), bars(wave(3000)))!;
  assert.equal(asDaily.days, 1095);
  assert.ok(a.trades > 0 && a.marks.filter((m) => m.side === 'buy').length === a.trades);
  // Too little hourly history (under 30 days after the look-back) is not scored.
  assert.equal(scoreMade(spec, market('BTCUSDT-PERPETUAL'), barsOf(wave(500), HOUR)), null);
});

test('4-hour agents score a year; the fee is charged per trade as for daily ones', async () => {
  const spec = { id: 'f', name: 'F', market: 'SOLUSDT', createdAt: 0, interval: '4h' as const, ...fromTemplate('rsi')! };
  const b = barsOf(wave(3000), 4 * HOUR);
  const sol = scoreMade(spec, market('SOLUSDT'), b)!;
  const btc = scoreMade({ ...spec, market: 'BTCUSDT-PERPETUAL' }, market('BTCUSDT-PERPETUAL'), b)!;
  assert.equal(sol.days, 365);
  assert.equal(sol.fee, FEE_HASHKEY);
  assert.equal(btc.fee, FEE_HSKSWAP);
  assert.equal(sol.trades, btc.trades);
  assert.ok(btc.total < sol.total, 'the higher per-trade fee costs return on the same candles');
});

test('the candle still forming is never decided on', async () => {
  const { closedOnly } = await import('./agents.ts');
  const b = barsOf([1, 2, 3], HOUR);
  const last = b[2].time;
  assert.equal(closedOnly(b, '1h', (last + HOUR - 1) * 1000).length, 2, 'the last hour is still open');
  assert.equal(closedOnly(b, '1h', (last + HOUR) * 1000).length, 3, 'closed on the hour');
});

test('a sentence can name the interval', async () => {
  const p = parse('1시간봉으로 RSI가 30 밑이면 사고 55 넘으면 팔아');
  assert.equal(p.interval, '1h');
  assert.equal(p.buy.length, 1);
  assert.equal(parse('on 4h candles buy when RSI is under 30, sell when RSI is over 55').interval, '4h');
  assert.equal(parse('RSI가 30 밑이면 사고 55 넘으면 팔아').interval, undefined, 'no interval named: the builder keeps its choice');
  assert.equal(parse('14일 수익률이 0보다 높으면 사').interval, undefined, '"14일" is not an hour');
});
