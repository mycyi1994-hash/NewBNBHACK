import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillKeepMs, scoreCollect, scoreMade, scorePosition, positions, overlays, FEE_HASHKEY, FEE_HSKSWAP, POSITION_RULES, PROOF, TIER, type Agent } from './agents.ts';
import { haircutModel, poolModel } from './fills.ts';
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

test('without the default in the list, the pick follows the list order: working now, then the smaller worst drop', () => {
  const agents = [fake({ id: 'boll-ETH', rule: 'boll', base: 'ETH', maxDd: 0.05, tier: 2, risk: 1 }), fake({ id: 'maEns-ETH', rule: 'maEns', base: 'ETH', maxDd: 0.2, tier: 1 })];
  assert.equal(recommend(agents, { coin: 'ETH', level: 'new' })!.pick.id, 'boll-ETH', 'no rank by origin or return: the smaller drop');
  // The default for the coin always comes first.
  assert.equal(recommend([...agents, fake({ id: 'basket-ETH', rule: 'basket', base: 'ETH', maxDd: 0.4, tier: 3 })], { coin: 'ETH', level: 'new' })!.pick.id, 'basket-ETH');
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
    // the default basket always holds at least half: never out
    if (r.id !== 'basket') assert.ok(all.some(Boolean) && !all.every(Boolean), `${r.id} should be in and out on a wave`);
    assert.ok(TIER[r.id] >= 1 && PROOF[r.id], `${r.id} has a tier and a proof level`);
    for (const o of overlays(r.id, b)) assert.equal(o.values.length, b.length);
  }
  assert.equal(POSITION_RULES.filter((r) => TIER[r.id] === 1).length + 1, 25, 'twenty-five published strategies: twenty-four position rules and plain DCA');
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
    fake({ id: 'brkAtr-ETH', rule: 'brkAtr', base: 'ETH', maxDd: 0.05, risk: 3 }),
    fake({ id: 'trend-ETH', rule: 'trend', base: 'ETH', maxDd: 0.12, risk: 2 }),
    fake({ id: 'boll-ETH', rule: 'boll', base: 'ETH', maxDd: 0.09, risk: 1 }),
    fake({ id: 'daily-ETH', rule: 'daily', kind: 'collect', base: 'ETH', maxDd: 0.3, risk: 1 }),
    fake({ id: 'trend-BTC', rule: 'trend', base: 'BTC', maxDd: 0.02, risk: 2 }),
  ];
  const pro = recommend(agents, { coin: 'ETH', level: 'pro' })!;
  assert.equal(pro.pick.id, 'brkAtr-ETH');
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

test('a bigger total alone does not put an agent ahead: the label rule decides, then the order', () => {
  const now = Date.now() / 1000;
  const steady = fake({ id: 'trend200-BTC', rule: 'trend200', tier: 1, maxDd: 0.1, total: 0.2, hold: 0.6, live: true });
  const bigger = fake({ id: 'break-BTC', rule: 'break', tier: 1, maxDd: 0.35, total: 0.9, hold: 0.6, marks: [{ time: now - 3 * DAY, side: 'buy', price: 1 }] });
  assert.equal(recommend([steady, bigger], { coin: 'BTC', level: 'pro' })!.pick.id, 'trend200-BTC');
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

/* ---------- short-term market agents ---------- */

test('short-term agents decide on their own candles and say so: interval carried, honest window', async () => {
  const A = await import('./agents.ts');
  const { STRINGS } = await import('./i18n.ts');
  const shorts = A.POSITION_RULES.filter((r) => A.ruleInterval(r.id) !== '1d').map((r) => r.id);
  assert.ok(shorts.length >= 8 && shorts.length <= 12, `${shorts.length} short-term rules`);
  const hourly = barsOf(wave(3000), HOUR), four = barsOf(wave(3000), 4 * HOUR);
  for (const id of shorts) {
    const iv = A.ruleInterval(id);
    const a = A.scorePosition(id, market('BTCUSDT-PERPETUAL'), iv === '1h' ? hourly : four)!;
    assert.ok(a, `${id} scores`);
    assert.equal(a.interval, iv, `${id} carries its interval`);
    assert.equal(a.days, iv === '1h' ? 90 : 365, `${id}: the window is the interval's own`);
    assert.equal(A.horizonOf(a), 'short');
    assert.equal(A.PROOF[id], 'none', `${id}: no published test on these candles`);
    assert.ok(A.TIER[id] >= 2, `${id} is not presented as a published classic`);
    for (const lang of ['en', 'ko'] as const) {
      const t = STRINGS[lang];
      for (const f of [t.agNick[id], t.agRule[id], t.agLine[id], t.agPlain[id], t.agOrigin[id], t.agFrom[id], t.agProof[id], t.ovLabel[id]]) assert.ok(f && f.length > 1, `${id} ${lang} text`);
      assert.equal(t.agRules[id].length, 2);
    }
  }
  assert.equal(STRINGS.ko.mpOver(90), '지난 90일 기준');
  assert.equal(STRINGS.en.mpOver(1095), 'over 3 years', 'daily agents read as before');
  assert.equal(A.ruleInterval('trend200'), '1d');
  // A daily agent is untouched by all this.
  assert.equal(A.scorePosition('trend', market('BTCUSDT-PERPETUAL'), bars(rising(2000)))!.interval, undefined);
});

test('short-term rules are the published rules on shorter candles, with the stated entry levels', async () => {
  const A = await import('./agents.ts');
  const b = barsOf(wave(1500), HOUR);
  for (const [s, base] of [['macd4h', 'macd'], ['bollh', 'boll'], ['rsih', 'rsi'], ['donch1h', 'break'], ['donch4h', 'break']] as const)
    assert.deepEqual(A.positions(s, b), A.positions(base, b), `${s} is ${base} on its candles`);
  const c = b.map((x) => x.close), r2 = (await import('./indicators.ts')).rsi(c, 2);
  const p = A.positions('rsi2h', b);
  for (let i = 1; i < b.length; i++) if (p[i] && !p[i - 1]) assert.ok(r2[i] < 10, 'Connors entry: RSI(2) under 10');
  // Decided on what was known at each close: a prefix of the candles gives a prefix of the positions.
  for (const id of ['rsi2h', 'ema921h', 'donch1h'] as const) assert.deepEqual(A.positions(id, b).slice(0, 700), A.positions(id, b.slice(0, 700)), `${id} never looks ahead`);
});

test('the engine takes a share of the money per candle; on/off rules pay exactly what they did', async () => {
  const A = await import('./agents.ts');
  const b = bars(wave(1400)), mk = market('BTCUSDT-PERPETUAL');
  const on = A.positions('trend', b);
  const asBool = A.backtest('x', 'trend', on, 60, mk, b, 1095)!;
  const asOnes = A.backtest('x', 'trend', on.map((x) => (x ? 1 : 0)), 60, mk, b, 1095)!;
  assert.equal(asOnes.total, asBool.total, 'shares of 0 and 1 are in and out');
  assert.equal(asBool.total, A.scorePosition('trend', mk, b)!.total);
  const half = A.backtest('x', 'trend', on.map((x) => (x ? 0.5 : 0)), 60, mk, b, 1095)!;
  assert.equal(half.trades, asBool.trades);
  assert.ok(Math.abs(half.total) < Math.abs(asBool.total), 'half the exposure, a smaller result either way');
  assert.equal(half.mult, half.live ? 0.5 : 0, 'the share it holds now');
});

test('a trailing stop exits on a fall from the high and waits for the rule to re-arm', async () => {
  const A = await import('./agents.ts');
  const closes = [...Array.from({ length: 40 }, () => 100), ...Array.from({ length: 20 }, (_, i) => 100 + i * 2), 110, 100, 95, 98, 104, 108];
  const b = bars(closes);
  const raw = closes.map(() => true);
  const st = A.withTrailingStop(raw, b, 2, 10);
  const exit = st.findIndex((x, i) => i > 40 && !x);
  assert.ok(exit > 59, 'held through the rise');
  assert.ok(st.slice(exit).every((x) => !x), 'stays out while the rule never went out');
  assert.deepEqual(A.withTrailingStop([...raw.slice(0, -2), false, true], b, 2, 10).slice(-1), [true], 're-arms after the rule goes out and back in');
});

/* ---------- the research set (quant-research.md #1–#7) ---------- */

test('the research set: published parameters, shares between 0 and 1, decided on past days only', async () => {
  const A = await import('./agents.ts');
  const wv = Array.from({ length: 900 }, (_, i) => 100 * (1 + 0.4 * Math.sin(i / 23)) * 1.0015 ** i);
  const b = bars(wv), c = wv;
  for (const r of ['volTarget', 'donchEns', 'tsmom3', 'coreTrend', 'maEns'] as const) {
    const tg = A.targets(r, b);
    assert.ok(tg.every((x) => x >= 0 && x <= 1), `${r} stays between 0 and 1`);
    assert.deepEqual(tg.slice(0, 600), A.targets(r, b.slice(0, 600)), `${r} never looks ahead`);
    const held = A.exposure(r, b) as number[];
    for (let i = 1; i < held.length; i++) if (held[i] !== held[i - 1]) assert.ok(Math.abs(held[i] - held[i - 1]) >= A.BAND[r] - 1e-9, `${r} only moves by its band`);
  }
  assert.equal(A.BAND.volTarget, 0.15); assert.equal(A.BAND.donchEns, 0.1);
  // B1: min(1, 50% / EWMA volatility with a 20-day half-life).
  const vol = A.ewmaVol(c, 20);
  A.targets('volTarget', b).forEach((x, i) => { if (Number.isFinite(vol[i])) assert.ok(Math.abs(x - Math.min(1, 0.5 / vol[i])) < 1e-12); });
  // A3: thirds, updated only on Mondays (UTC).
  const m = A.targets('tsmom3', b);
  for (let i = 92; i < b.length; i++) {
    assert.ok([0, 1 / 3, 2 / 3, 1].some((v) => Math.abs(v - m[i]) < 1e-12));
    if (new Date(b[i].time * 1000).getUTCDay() !== 1) assert.equal(m[i], m[i - 1], 'holds between Mondays');
    else assert.equal(m[i], [7, 28, 91].filter((d) => c[i] > c[i - d]).length / 3);
  }
  // B3: half the B1 share always, half the B1 share times the A3 score.
  const core = A.targets('coreTrend', b), v1 = A.targets('volTarget', b);
  core.forEach((x, i) => assert.ok(Math.abs(x - (0.5 * v1[i] + 0.5 * m[i] * v1[i])) < 1e-12));
  // A2: thirds by how many of the 20-, 50-, 100-day averages the close is above.
  assert.ok(A.targets('maEns', b).every((x) => [0, 1 / 3, 2 / 3, 1].some((v) => Math.abs(v - x) < 1e-12)));
  // A4 + C1 and the Turtle/Donchian variants are in or out, and the stop only ever removes days from the parent.
  for (const [g, p] of [['breakC', 'break'], ['turtle2C', 'turtle2'], ['donchianC', 'donchian']] as const) {
    const guarded = A.positions(g, b), parent = A.positions(p, b);
    assert.ok(guarded.every((x, i) => !x || parent[i]), `${g} holds only when ${p} would`);
  }
  assert.deepEqual(A.positions('brkAtr', b).slice(0, 600), A.positions('brkAtr', b.slice(0, 600)));
});

test('a weight agent is scored on its share, carries its live target, and reports its average exposure', async () => {
  const A = await import('./agents.ts');
  const b = bars(Array.from({ length: 1400 }, (_, i) => 100 * (1 + 0.3 * Math.sin(i / 40)) * 1.001 ** i));
  const a = A.scorePosition('volTarget', market('BTCUSDT-PERPETUAL'), b)!;
  assert.equal(a.days, 1095);
  assert.equal(a.band, 0.15);
  assert.ok(a.target !== undefined && a.target >= 0 && a.target <= 1);
  assert.ok(a.exposure! > 0 && a.exposure! <= 1);
  assert.equal(a.mult, (A.exposure('volTarget', b) as number[])[b.length - 1], 'what it holds today, after the band');
  assert.ok((a.moves ?? 0) >= a.trades, 'every resize is a trade');
  assert.ok(a.marks.filter((x) => x.resize).every((x) => (x.mult ?? 0) > 0 && (x.mult ?? 0) <= 1));
  // Costs on the share that changes hands: a flat price and a share that moves 0 → 0.5 → 1 → 0 pays 0.5 + 0.5 + 1 of
  // one side's cost. BTC has a pool; with its gap not read in this test, a side costs the 0.3% fee plus the 0.5% haircut.
  const flat = bars(Array.from({ length: 300 }, () => 100));
  const path = flat.map((_, i) => (i < 100 ? 0 : i < 150 ? 0.5 : i < 200 ? 1 : 0));
  const t = A.backtest('x', 'volTarget', path, 60, market('BTCUSDT-PERPETUAL'), flat, 1095)!;
  assert.ok(Math.abs(t.total - ((1 - 0.008 * 0.5) ** 2 * (1 - 0.008) - 1)) < 1e-12);
  assert.equal(t.fill?.source, 'haircut');
  assert.equal(t.trades, 1, 'one entry');
  assert.equal(t.moves, 3, 'three trades');
  // An on/off agent has no target: the runner treats it as in or out.
  assert.equal(A.scorePosition('trend', market('BTCUSDT-PERPETUAL'), b)!.target, undefined);
});

test('retired and demoted per the research; a retired agent can still be found by anyone who hired it', async () => {
  const A = await import('./agents.ts');
  for (const r of ['rsi2', 'double7', 'boll'] as const) {
    assert.ok(A.isRetired({ rule: r, base: 'BTC' }) && A.isRetired({ rule: r, base: 'ETH' }), `${r} retired on BTC and ETH`);
    assert.ok(!A.isRetired({ rule: r, base: 'HSK' }), `${r} stays on HSK`);
  }
  assert.ok(A.isRetired({ rule: 'macd', base: 'HSK' }), 'standalone MACD retired everywhere');
  assert.ok(!A.isRetired({ rule: 'rsi2h', base: 'BTC' }) && !A.isRetired({ rule: 'macd4h', base: 'BTC' }), 'the short-term set stays, labelled');
  for (const r of ['golden', 'ichimoku', 'trend200', 'break', 'psar', 'adx', 'aroon', 'keltner'] as const) assert.ok(A.DEMOTED.has(r), `${r} demoted`);
  assert.ok(!A.DEMOTED.has('breakC') && !A.DEMOTED.has('volTarget'));
  for (const r of ['tsmom', 'multiTrend', 'dualMom'] as const) assert.ok(!A.DEMOTED.has(r), `${r} promoted out of the classics`);
  // agentById looks the rule up with the retired ones included (positionAgents(m, true)); the market lists without them.
  const src = (await import('node:fs')).readFileSync(new URL('./agents.ts', import.meta.url), 'utf8');
  assert.match(src, /positionAgents\(m, true\)\)\.find\(\(a\) => a\.id === id\)/);
});

/* ---------- out-of-sample split and the decision inputs ---------- */

test('every backtest is cut in three: early, the ranking year, and a holdout that ranking never reads', async () => {
  const A = await import('./agents.ts');
  const b = bars(Array.from({ length: 1400 }, (_, i) => 100 * (1 + 0.3 * Math.sin(i / 40)) * 1.001 ** i));
  for (const r of ['trend', 'maEns', 'volTarget', 'breakC'] as const) {
    const a = A.scorePosition(r, market('BTCUSDT-PERPETUAL'), b)!;
    const s = a.split!;
    assert.ok(Math.abs((1 + s.early.total) * (1 + s.pick.total) * (1 + s.holdout.total) - (1 + a.total)) < 1e-9, `${r}: the three parts make the whole`);
    assert.ok(Math.abs((1 + s.early.hold) * (1 + s.pick.hold) * (1 + s.holdout.hold) - (1 + a.hold)) < 1e-9);
    assert.equal(A.holdoutDays(a), 91, 'the last twelfth of three years: about three months');
    assert.equal(A.pickDays(a), 365, 'the ranking year ends where the holdout starts');
    const ht = A.holdTest(a);
    assert.equal(A.beatsHold(a), a.total > a.hold && ht.excessSharpe >= ht.hurdle && ht.blocks.length === 3 && ht.won >= 2 && ht.exposure >= 0.25, 'the label reads the whole window');
    assert.equal(A.oosEdge(a), s.pick.total - s.pick.hold);
    assert.deepEqual(A.holdNumbers(a), { full: a.total - a.hold, fullDays: a.days, edge: s.pick.total - s.pick.hold, days: 365, ago: 91, holdout: s.holdout.total - s.holdout.hold, mixed: s.pick.total - s.pick.hold > 0 && a.total - a.hold < 0 });
  }
});

test('the last three months alone never make an agent "ahead"', async () => {
  const A = await import('./agents.ts');
  const base = Array.from({ length: 1400 }, (_, i) => 100 * (1 + 0.3 * Math.sin(i / 40)) * 1.001 ** i);
  const crash = base.map((v, i) => (i >= 1400 - 80 ? v * 0.4 : v));   // only the last months differ
  for (const r of ['trend', 'maEns', 'volTarget', 'breakC', 'ema'] as const) {
    const a = A.scorePosition(r, market('BTCUSDT-PERPETUAL'), bars(crash))!;
    // sitting out a crash in the last three months is not a three-year edge: the label needs 2 of 3 yearly blocks
    if (A.beatsHold(a)) assert.ok(A.holdTest(a).won >= 2 && A.holdTest(a).excessSharpe >= A.luckHurdle(a.days));
    assert.ok(a.split!.holdout, 'the holdout is still reported');
  }
});

test('each scored agent keeps the inputs its last decision compared, for the journal', async () => {
  const A = await import('./agents.ts');
  const b = bars(Array.from({ length: 1400 }, (_, i) => 100 * (1 + 0.3 * Math.sin(i / 40)) * 1.001 ** i));
  const t = A.scorePosition('trend', market('ETHUSDT-PERPETUAL'), b)!;
  assert.equal(t.decision!.candle, b[b.length - 1].time);
  assert.equal(t.decision!.close, b[b.length - 1].close);
  assert.ok(Math.abs(t.decision!.values['line1.main'] - b.slice(-50).reduce((s, x) => s + x.close, 0) / 50) < 1e-9, 'the 50-day average it compared');
  assert.deepEqual(t.decision!.out, { live: t.live, mult: t.mult });
  const v = A.scorePosition('volTarget', market('ETHUSDT-PERPETUAL'), b)!;
  assert.equal(v.decision!.values.target, v.target);
  assert.ok(v.decision!.values.vol > 0);
  assert.deepEqual(v.decision!.out, { live: v.live, mult: v.mult, target: v.target, band: 0.15 });
  const made = scoreMade({ id: 'm', name: 'M', market: 'ETHUSDT-PERPETUAL', createdAt: 0, ...fromTemplate('rsi')! }, market('ETHUSDT-PERPETUAL'), b)!;
  assert.ok(Number.isFinite(made.decision!.values['buy1.a']) && made.decision!.values['buy1.b'] === 30, 'a made rule: each condition’s two sides');
});

test('the label rule: luck hurdle, 2 of 3 yearly blocks and the exposure guard', async () => {
  const A = await import('./agents.ts');
  const D = 86_400, days = 1095;
  // daily curves: holding drifts, the agent adds a steady extra each day (a clean, high excess Sharpe)
  const curve = (f: (i: number) => number) => Array.from({ length: days + 1 }, (_, i) => ({ time: i * D, value: f(i) }));
  const noise = (i: number) => 1 + 0.002 * Math.sin(i * 1.7);
  const bench = curve((i) => 1.0003 ** i * noise(i));
  const steady = { kind: 'position' as const, days, inMarket: 1, exposure: 0.8, bench, equity: curve((i) => 1.0003 ** i * noise(i) * 1.002 ** i) };
  const s1 = { ...steady, total: steady.equity[days].value - 1, hold: bench[days].value - 1 };
  assert.equal(A.yearly(s1).length, 3);
  assert.ok(A.holdTest(s1).excessSharpe >= A.luckHurdle(days), 'clears √(2·ln 30 / 3) ≈ 1.5');
  assert.equal(A.beatsHold(s1), true);
  assert.ok(Math.abs(A.luckHurdle(1095) - Math.sqrt((2 * Math.log(30)) / 3)) < 1e-9);
  // ahead only in one year: fails the 2-of-3 rule however big the total
  const lucky = curve((i) => 1.0003 ** i * noise(i) * (i > 730 ? 1.004 ** (i - 730) : 1));
  const s2 = { ...steady, equity: lucky, total: lucky[days].value - 1, hold: bench[days].value - 1 };
  assert.equal(A.holdTest(s2).won, 1);
  assert.equal(A.beatsHold(s2), false);
  // held almost nothing: the exposure guard
  assert.equal(A.beatsHold({ ...s1, exposure: 0.1 }), false);
  // a short history (one year) has no three blocks: never ahead
  const short = { ...s1, days: 365, equity: s1.equity.slice(-366), bench: bench.slice(-366) };
  assert.equal(A.beatsHold(short), false);
  // periodResult: the last 365 days against holding
  const p = A.periodResult(s1, 365)!;
  assert.ok(Math.abs(p.total - (s1.equity[days].value / s1.equity[days - 365].value - 1)) < 1e-9);
  assert.equal(A.periodResult(s1, 5000), undefined, 'longer than the backtest');
});

test('tiers: the default basket first, lab agents last and never recommended, then working now and the smaller drop', async () => {
  const A = await import('./agents.ts');
  const { recommend } = await import('./recommend.ts');
  const b = bars(Array.from({ length: 1400 }, (_, i) => 100 * (1 + 0.3 * Math.sin(i / 40)) * 1.001 ** i));
  const m = market('BTCUSDT-PERPETUAL');
  const xs = (['basket', 'tsmom', 'tsmom3', 'volTarget', 'trend', 'golden'] as const).map((r) => ({ ...A.scorePosition(r, m, b)!, runnable: true }));
  const by = (r: string) => xs.find((a) => a.rule === r)!;
  assert.equal(A.tierOf(by('basket')), 'default');
  assert.equal(A.tierOf(by('tsmom3')), 'lab', 'the 7/28/91-day momentum agent is lab');
  assert.equal(A.needsLabConfirm(by('tsmom3')), true);
  assert.equal(A.needsLabConfirm(by('basket')), false);
  for (const a of xs) assert.ok(A.LIST_TIERS.includes(A.tierOf(a)));
  const order = [...xs].sort(A.byMerit).map((a) => A.tierOf(a));
  assert.equal(order[0], 'default');
  assert.equal(order[order.length - 1], 'lab');
  assert.deepEqual(order, [...order].sort((p, q) => A.LIST_TIERS.indexOf(p) - A.LIST_TIERS.indexOf(q)), 'tiers never interleave');
  const r = recommend(xs, { coin: 'BTC' })!;
  assert.equal(r.pick.rule, 'basket', 'the default is the pick');
  assert.ok(!r.others.some((a) => A.tierOf(a) === 'lab'));
  assert.equal(recommend(xs, { coin: 'BTC', exclude: [by('basket').id] })!.pick.rule === 'tsmom3', false, 'a lab agent is never the pick');
  // a calmer agent: smaller worst drop than holding over the same days, not ahead
  for (const a of xs) if (A.tierOf(a) === 'calmer') assert.ok(a.maxDd < A.holdDrop(a) && !A.beatsHold(a));
});

test('the basket holds half always, checks monthly, and trades only on a 25-point move', async () => {
  const A = await import('./agents.ts');
  // a year of rise, a year of fall, a year of rise
  const closes = Array.from({ length: 1500 }, (_, i) => 100 * (i < 500 ? 1.002 ** i : i < 1000 ? 1.002 ** 500 * 0.998 ** (i - 500) : 1.002 ** 500 * 0.998 ** 500 * 1.002 ** (i - 1000)));
  const b = bars(closes);
  const t = A.basketTarget(b);
  assert.ok(t.every((x) => [0.5, 0.5 + 0.5 / 3, 0.5 + 1 / 3, 1].some((v) => Math.abs(x - v) < 1e-9)), 'targets are 50/67/83/100%');
  // the target only changes on the first candle of a month
  for (let i = 1; i < b.length; i++) if (t[i] !== t[i - 1]) assert.notEqual(new Date(b[i].time * 1000).getUTCMonth(), new Date(b[i - 1].time * 1000).getUTCMonth());
  const held = A.exposure('basket', b);
  const shares = held.map((x) => Number(x));
  assert.ok(shares.slice(400).every((x) => x >= 0.5 - 1e-9), 'never under half once started');
  for (let i = 401; i < shares.length; i++) if (shares[i] !== shares[i - 1]) assert.ok(Math.abs(shares[i] - shares[i - 1]) >= 0.25 - 1e-9, 'a trade only on a 25-point move');
  const a = A.scorePosition('basket', market('BTCUSDT-PERPETUAL'), b)!;
  assert.equal(a.band, 0.25);
  assert.ok(a.moves! <= 12, `few trades over three years (${a.moves})`);
  assert.equal(a.yearly!.length, 3);
});

test('the headline is the whole period; a better ranking year over a worse whole period is flagged to be said in words', async () => {
  const A = await import('./agents.ts');
  const mk = (full: number, pick: number) => ({ total: full, hold: 0, days: 1095, to: 0, split: { at: -365 * 86_400 - 91 * 86_400, holdoutAt: -91 * 86_400, early: { total: 0, hold: 0 }, pick: { total: pick, hold: 0, exposure: 0.5 }, holdout: { total: 0.02, hold: 0, exposure: 0.5 }, rank: { maxDd: 0, sharpe: 0, trades: 1, total: 0 } } }) as unknown as Parameters<typeof A.holdNumbers>[0];
  const h = A.holdNumbers(mk(-0.773, 0.138));
  assert.equal(h.full, -0.773, 'the whole period leads');
  assert.equal(h.edge, 0.138);
  assert.equal(h.mixed, true, 'ahead over the ranking year, behind over all of it');
  assert.equal(h.holdout, 0.02);
  assert.equal(A.holdNumbers(mk(0.1, 0.2)).mixed, false);
  assert.equal(A.holdNumbers(mk(-0.1, -0.2)).mixed, false, 'no claim to qualify');
  const { STRINGS } = await import('./i18n.ts');
  assert.equal(STRINGS.ko.mixedNote('최근 1년', '3년'), '최근 1년은 보유보다 나았지만 3년 전체로는 뒤졌어요.');
  assert.match(STRINGS.ko.recCoin('BTC', true, '3달 전까지 1년', '+13.8%', '전체 3년 −77.3%', STRINGS.ko.mixedNote('3달 전까지 1년', '3년')), /전체 3년 −77\.3%.*\+13\.8%.*3년 전체로는 뒤졌어요/);
});

test('how long a pool fill model is kept: a measured one and a quiet pool six hours, a read that may have failed one hour', () => {
  const H = 3_600_000;
  assert.equal(fillKeepMs(poolModel(undefined, { median: 0, mad: 0.001, n: 20 })), 6 * H);
  assert.equal(fillKeepMs(haircutModel()), H, 'a haircut may be a failed read: tried again sooner');
  assert.equal(fillKeepMs(haircutModel(), true), 6 * H, 'the read worked and the pool had too few swaps: asking hourly changes nothing');
  assert.equal(fillKeepMs(undefined), H);
});
