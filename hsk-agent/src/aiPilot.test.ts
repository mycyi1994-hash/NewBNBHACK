import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_EVERY_MS, BAND, COOLDOWN_MS, CUT, LIMITS, STEP, aiAgent, buildSnapshot, decisionHash, forModel, guard, guardPoints, heldDecision, inputsMissing, isDue, lastClosedCandle, madeDecision,
  paperTrack, parseOutput, plain, verifyDecision, type AiDecision, type AiFeed, type AiSnapshot,
} from './aiPilot.ts';
import { AI_TEXT } from './aiText.ts';
import { beatsHold } from './agents.ts';
import { agentSignal, decide, type HiredAgent } from './runner.ts';
import { journalHash, makeJournal, verifyJournal } from './journal.ts';

const H4 = AI_EVERY_MS / 1000, DAY = 86_400;
// 2027-01-15 08:00 UTC: a 4-hour boundary.
const T0 = 1_799_971_200;
const NOW = (T0 + 10 * 60) * 1000;   // ten minutes after the 08:00 close of the 04:00 candle
const daily = (n: number, end: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ time: end - (n - i) * DAY, open: f(i), high: f(i), low: f(i), close: f(i), volume: 1 }));
const h4 = (end: number, close: number) => Array.from({ length: 6 }, (_, i) => ({ time: end - (6 - i) * H4, open: close, high: close, low: close, close, volume: 1 }));

test('guard: clamp to 0..1 and round to 5%', () => {
  assert.deepEqual(guard(0.5, 1.7), { target: 0.75, guard: { clamped: true, stepped: true } });
  assert.deepEqual(guard(0.5, -3), { target: 0, guard: { clamped: true } }, 'clamped to 0: a 50-point cut is allowed');
  assert.equal(guard(0.8, 0.98).target, 1, 'rounded to 1.0: a 20-point move, within the step and above the band');
  assert.equal(guard(0.8, 1.02).target, 1);
  assert.equal(guard(0.4, 0.62).target, 0.6, '0.62 rounds to 0.60');
  assert.equal(guard(0.4, 0.63).target, 0.65, '0.63 rounds to 0.65');
});
test('guard: up at most 25 points a decision, from nothing held at the start', () => {
  assert.deepEqual(guard(null, 1), { target: 0.25, guard: { stepped: true } });
  assert.equal(guard(0.25, 1).target, 0.5);
  assert.equal(guard(0.5, 0.75).target, 0.75, 'exactly the step is not limited');
  assert.equal(STEP, 0.25);
});
test('guard: risk comes off faster than it goes on: down at most 50 points a decision', () => {
  assert.equal(CUT, 0.5);
  assert.ok(CUT > STEP);
  assert.deepEqual(guard(1, 0), { target: 0.5, guard: { stepped: true } }, '100% to 0%: half now');
  assert.deepEqual(guard(0.5, 0), { target: 0, guard: {} }, 'and the rest at the next decision: out in two, not four');
  assert.equal(guard(0.6, 0).target, 0.1);
  assert.equal(guard(0.75, 0.3).target, 0.3, 'a 45-point cut goes through whole');
  assert.equal(guard(0.3, 0.75).target, 0.55, 'the same distance up is still limited to 25');
  assert.equal(guard(1, 0.95).target, 1, 'a cut under the band is still no move');
  // the limits are an argument: a decision is always judged by the ones it is given
  assert.equal(guard(1, 0, { band: 0.15, step: 0.25, cut: 0.25 }).target, 0.75);
  assert.deepEqual(guard(0, 0.1, { band: 0.15, step: 0.25, cut: 0.25 }), { target: 0, guard: { banded: true } });
});
test('guard: a move under 10 points is no move', () => {
  assert.deepEqual(guard(0.5, 0.55), { target: 0.5, guard: { banded: true } });
  assert.deepEqual(guard(0.5, 0.45), { target: 0.5, guard: { banded: true } });
  assert.equal(guard(0.5, 0.6).target, 0.6, 'exactly the band moves');
  assert.equal(guard(null, 0.1).target, 0.1, 'a first 10% is held: a small share is not nothing');
  assert.equal(guard(null, 0.05).target, 0, 'a first 5% stays at nothing');
  assert.deepEqual(guard(0.5, 0.5), { target: 0.5, guard: {} });
  assert.equal(BAND, 0.10);
});

test('cool-down: one decision per closed 4-hour candle, never sooner than the interval', () => {
  const candle = lastClosedCandle(NOW);
  assert.equal(candle, T0 - H4, 'the 04:00 candle closed at 08:00');
  assert.equal(isDue(undefined, candle, NOW), true);
  assert.equal(isDue({ at: NOW - 60_000, candle }, candle, NOW), false, 'that candle is decided');
  assert.equal(isDue({ at: NOW - 60_000, candle: candle - H4 }, candle, NOW), false, 'a new candle, but the last decision was a minute ago');
  assert.equal(isDue({ at: NOW - COOLDOWN_MS, candle: candle - H4 }, candle, NOW), true);
  // a first decision made mid-candle (after a deploy) does not push the next one past the next close
  assert.equal(isDue({ at: NOW - 78 * 60_000, candle: candle - H4 }, candle, NOW), true, 'decided 1h18m ago on the candle before: due now');
  assert.equal(COOLDOWN_MS, 60 * 60_000);
  assert.equal(isDue({ at: NOW - AI_EVERY_MS, candle: candle - H4 }, candle, NOW), true);
});

test('snapshot: numbers computed in code, nothing missing guessed', () => {
  const d = daily(260, T0 - 8 * 3600, (i) => 100 + i);   // closes 100..359, the last daily closed at 00:00
  const r = buildSnapshot({ asset: 'BTC', now: NOW, daily: d, h4: h4(T0, 400), prevTarget: 0.5 });
  assert.ok(r.ok);
  const s = r.snap;
  assert.equal(s.price, 400);
  assert.equal(s.candle, T0 - H4);
  assert.ok(Math.abs(s.ma20! - (340 + 359) / 2) < 1e-9, 'mean of the last 20 closes');
  assert.ok(Math.abs(s.vsMa200! - (400 / ((160 + 359) / 2) - 1)) < 1e-9);
  assert.ok(Math.abs(s.ret1d! - (400 / 358 - 1)) < 1e-9, 'against the daily close a full day before the 4-hour close');
  assert.ok(Math.abs(s.ret7d! - (400 / 352 - 1)) < 1e-9);
  assert.ok(s.vol20! > 0);
  assert.equal(s.prevTarget, 0.5);
  assert.equal('poolGap' in s, false, 'no pool read: no pool keys');
  assert.equal('flowNet24h' in s, false);
  assert.deepEqual(s.missing, ['pool'], 'and the snapshot says the pool is missing (BTC has no flow input, so that is not missing)');
  for (const [k, v] of Object.entries(s)) if (k !== 'asset' && k !== 'missing') assert.equal(typeof v, 'number', `${k} is a number`);
  assert.equal(forModel(s).missing, 'pool', 'the model is told too');
  const bare = buildSnapshot({ asset: 'HSK', now: NOW, daily: d, h4: h4(T0, 400), prevTarget: null });
  assert.ok(bare.ok);
  assert.deepEqual(bare.snap.missing, ['pool', 'flow'], 'HSK with neither read: both named');
  const withPool = buildSnapshot({ asset: 'HSK', now: NOW, daily: d, h4: h4(T0, 400), prevTarget: null, pool: { price: 398, gap: -0.005, roundTrip: 0.0071, depth2pct: 12000 }, flow: { net24h: -1200, buy24h: 800, sell24h: 2000, swaps24h: 31, net7d: 400 } });
  assert.ok(withPool.ok);
  assert.equal(withPool.snap.poolGap, -0.005);
  assert.equal(withPool.snap.flowSwaps24h, 31);
  assert.equal('missing' in withPool.snap, false, 'everything read: nothing missing, no key');
  assert.equal('poolAgeMin' in withPool.snap, false, 'read just now: no age');
  // inputs from the server's own record carry their age, and a week that is not read yet is left out
  const aged = buildSnapshot({ asset: 'HSK', now: NOW, daily: d, h4: h4(T0, 400), prevTarget: null, pool: { price: 398, gap: -0.005, ageMin: 12.4 }, flow: { net24h: 5, buy24h: 10, sell24h: 5, swaps24h: 3, ageMin: 7.6 } });
  assert.ok(aged.ok);
  assert.deepEqual([aged.snap.poolAgeMin, aged.snap.flowAgeMin, 'flowNet7d' in aged.snap, aged.snap.missing], [12, 8, false, undefined]);
  assert.deepEqual([forModel(aged.snap).poolAgeMin, forModel(aged.snap).flowAgeMin], [12, 8]);
  assert.equal('prevTarget' in withPool.snap, false, 'no target in force yet: no key');
  const m = forModel(withPool.snap);
  assert.equal(m.poolGapPct, -0.5, 'shares become percents for the model');
  assert.equal(m.candleClosedUtc, new Date(T0 * 1000).toISOString());
  assert.equal(Object.values(m).every((v) => typeof v === 'number' || v === 'HSK' || v === m.candleClosedUtc), true, 'numbers, the coin and the code-made time only');
});
test('snapshot: old or short data is not decided on', () => {
  const d = daily(260, T0 - 8 * 3600, (i) => 100 + i);
  assert.deepEqual(buildSnapshot({ asset: 'BTC', now: NOW, daily: d, h4: h4(T0 - 2 * H4, 400), prevTarget: null }), { ok: false, why: 'stale' });
  assert.deepEqual(buildSnapshot({ asset: 'BTC', now: NOW, daily: d.slice(-150), h4: h4(T0, 400), prevTarget: null }), { ok: false, why: 'noData' });
  assert.deepEqual(buildSnapshot({ asset: 'BTC', now: NOW, daily: d, h4: [], prevTarget: null }), { ok: false, why: 'noData' });
});

test('parsing: strict about the form, plain words only', () => {
  const ok = parseOutput('{"target":0.6,"reason":"Above all three averages, volatility 40%.","reason_ko":"세 평균선 위, 변동성 40%.","signals":["vsMa50","vol20","nonsense","vol20"]}');
  assert.deepEqual(ok, { ok: true, target: 0.6, reason: 'Above all three averages, volatility 40%.', reasonKo: '세 평균선 위, 변동성 40%.', signals: ['vsMa50', 'vol20'] });
  assert.equal(parseOutput('not json').ok, false);
  assert.equal(parseOutput({ target: 'lots', reason: 'x', reason_ko: 'y', signals: [] }).ok, false);
  assert.equal(parseOutput({ target: NaN, reason: 'x', reason_ko: 'y', signals: [] }).ok, false);
  assert.equal(parseOutput({ target: 0.5, reason: '   ', reason_ko: 'y', signals: [] }).ok, false);
  assert.equal(parseOutput({ target: 0.5, reason: 'x', signals: [] }).ok, false);
  assert.equal(parseOutput([0.5]).ok, false);
  const long = parseOutput({ target: 2, reason: `<b>Buy</b> now https://evil.example/x ${'a'.repeat(400)}`, reason_ko: 'y', signals: 'vol20' });
  assert.ok(long.ok);
  assert.equal(long.target, 2, 'out of range is the guard’s to clamp, not a parse failure');
  assert.ok(long.reason.length <= 200 && !/[<>]|https?:/.test(long.reason));
  assert.deepEqual(long.signals, []);
  assert.equal(plain('a\n\tb  c'), 'a b c');
});

const snap: AiSnapshot = { asset: 'ETH', candle: T0 - H4, price: 2000, ret7d: 0.03, vol20: 0.5, prevTarget: 0.5 };
test('decisions are hashed and the hash checks', () => {
  const d = madeDecision({ at: NOW, asset: 'ETH', prev: 0.5, model: 'claude-sonnet-5-5', snapshot: snap }, { target: 0.9, reason: 'Up 3% on the week.', reasonKo: '한 주에 3% 올랐어요.', signals: ['ret7d'] });
  assert.equal(d.target, 0.75, 'stepped');
  assert.equal(d.proposed, 0.9);
  assert.deepEqual(d.guard, { stepped: true });
  assert.match(d.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(verifyDecision(d), true);
  assert.equal(verifyDecision({ ...d, reason: 'Something else.' }), false, 'changing the reason breaks the hash');
  assert.equal(verifyDecision({ ...d, snapshot: { ...snap, price: 2001 } }), false, 'changing an input breaks it too');
  const { hash, ...rest } = d;
  assert.equal(decisionHash(rest), hash);
  const h = heldDecision({ at: NOW, candle: T0 - H4, asset: 'ETH', prev: 0.4, model: 'claude-sonnet-5-5', snapshot: snap }, 'timeout');
  assert.equal(h.target, 0.4, 'held: the target in force stays');
  assert.equal(h.held, 'timeout');
  assert.equal(verifyDecision(h), true);
});

// The first decision the live server recorded (public at /api/ai/decisions?asset=BTC), exactly as stored: made when
// the band was 15 points, with no limits and no pool inputs in the record.
const LIVE_FIRST = JSON.parse("{\"at\":1795833765548,\"candle\":1795809600,\"asset\":\"BTC\",\"model\":\"claude-sonnet-5-5\",\"target\":0,\"proposed\":0.1,\"prev\":null,\"reason\":\"BTC is 8.1% below its 20-day, 19.4% below its 50-day and 16.6% below its 200-day average, with 30-day return -26.4%. The trend is down, so hold little.\",\"reasonKo\":\"BTC는 20일 평균보다 8.1%, 50일보다 19.4%, 200일보다 16.6% 낮고 30일 수익률은 -26.4%입니다. 하락 추세라 비중을 낮게 유지합니다.\",\"signals\":[\"vsMa20\",\"vsMa200\",\"ret30d\",\"vol20\"],\"guard\":{\"banded\":true},\"price\":59900.3,\"snapshot\":{\"asset\":\"BTC\",\"candle\":1795809600,\"price\":59900.3,\"ret1d\":-0.01104356669726514,\"ret7d\":0.0168621725771132,\"ret30d\":-0.26371704259111295,\"ret90d\":-0.23411532452122863,\"ma20\":65209.19500000001,\"vsMa20\":-0.08141328841737738,\"ma50\":74317.78200000002,\"vsMa50\":-0.19399774336645315,\"ma200\":71845.53649999999,\"vsMa200\":-0.16626275036584892,\"vol20\":0.45475582817079657},\"hash\":\"0x154fac72fff59815d1f8ccad0da2d295923ce2163373df3946da32948275ccb4\"}") as AiDecision;
test('each decision records the limits it was made under; one recorded before that still checks and gets no number', () => {
  const d = madeDecision({ at: NOW, asset: 'ETH', prev: 0.5, model: 'm', snapshot: snap }, { target: 0.55, reason: 'r', reasonKo: 'r', signals: [] });
  assert.deepEqual(d.guard, { banded: true });
  assert.deepEqual(d.limits, LIMITS);
  assert.deepEqual(d.limits, { band: BAND, step: STEP, cut: CUT });
  assert.equal(guardPoints(d, 'banded'), 10);
  assert.equal(verifyDecision(d), true, 'the limits are part of what is hashed');
  assert.equal(verifyDecision({ ...d, limits: { ...LIMITS, band: 0.15 } }), false);
  const cut = madeDecision({ at: NOW, asset: 'ETH', prev: 1, model: 'm', snapshot: snap }, { target: 0, reason: 'r', reasonKo: 'r', signals: [] });
  assert.deepEqual([cut.target, guardPoints(cut, 'stepped')], [0.5, 50], 'a cut says the cut limit');
  const up = madeDecision({ at: NOW, asset: 'ETH', prev: 0, model: 'm', snapshot: snap }, { target: 1, reason: 'r', reasonKo: 'r', signals: [] });
  assert.deepEqual([up.target, guardPoints(up, 'stepped')], [0.25, 25], 'a rise says the step');
  // a decision made under other limits keeps saying those, whatever today's are
  const then = madeDecision({ at: NOW, asset: 'ETH', prev: 0, model: 'm', snapshot: snap }, { target: 0.1, reason: 'r', reasonKo: 'r', signals: [] }, { band: 0.15, step: 0.25, cut: 0.25 });
  assert.deepEqual([then.target, guardPoints(then, 'banded')], [0, 15]);
  // the stored record from before: untouched, its hash still recomputes, and no number is claimed for it
  assert.equal(verifyDecision(LIVE_FIRST), true);
  assert.deepEqual(LIVE_FIRST.guard, { banded: true });
  assert.equal(LIVE_FIRST.limits, undefined);
  assert.equal(guardPoints(LIVE_FIRST, 'banded'), null, 'a 10% proposal held by the 15-point band of the time: not labelled "under 10 points"');
});

test('a decision says which inputs it lacked; an earlier one is read from its snapshot', () => {
  const lacking = madeDecision({ at: NOW, asset: 'HSK', prev: 0, model: 'm', snapshot: { ...snap, asset: 'HSK', missing: ['pool', 'flow'] } }, { target: 0.2, reason: 'r', reasonKo: 'r', signals: [] });
  assert.deepEqual(lacking.missing, ['pool', 'flow']);
  assert.deepEqual(inputsMissing(lacking), ['pool', 'flow']);
  assert.equal(verifyDecision(lacking), true);
  const held = heldDecision({ at: NOW, candle: T0 - H4, asset: 'HSK', prev: 0.2, model: 'm', snapshot: { ...snap, asset: 'HSK', missing: ['flow'] }, fail: '400 invalid_request_error' }, 'callFailed');
  assert.deepEqual([held.missing, held.fail, held.limits], [['flow'], '400 invalid_request_error', LIMITS], 'a held decision keeps the limits in force too');
  assert.equal(verifyDecision(held), true);
  const whole = madeDecision({ at: NOW, asset: 'ETH', prev: 0, model: 'm', snapshot: { ...snap, poolPrice: 2001 } }, { target: 0.2, reason: 'r', reasonKo: 'r', signals: [] });
  assert.equal('missing' in whole, false);
  assert.deepEqual(inputsMissing(whole), []);
  assert.deepEqual(inputsMissing(LIVE_FIRST), ['pool'], 'the live record never had the pool: said, not left blank');
  assert.deepEqual(inputsMissing({ ...LIVE_FIRST, asset: 'HSK' }), ['pool', 'flow']);
  assert.deepEqual(inputsMissing(heldDecision({ at: NOW, candle: 0, asset: 'HSK', prev: null, model: null }, 'noData')), [], 'no snapshot at all: nothing is claimed');
});

test('the rule text people read states the limits the code applies', () => {
  const [up, down, band] = [STEP, CUT, BAND].map((x) => Math.round(x * 100));
  assert.match(AI_TEXT.en.aiPilot.rules[1], new RegExp(`up at most ${up} points.*down at most ${down}.*under ${band} points`));
  assert.match(AI_TEXT.ko.aiPilot.rules[1], new RegExp(`${up}%p까지.*${down}%p까지.*${band}%p`));
});

const feed = (decisions: AiDecision[], state: AiFeed['state'] = 'on'): AiFeed => ({ asset: 'ETH', state, every: AI_EVERY_MS, model: 'claude-sonnet-5-5', decisions, paper: paperTrack(decisions), count: decisions.length });
const made = (at: number, prev: number | null, want: number, price: number) => madeDecision({ at, asset: 'ETH', prev, model: 'm', snapshot: { ...snap, candle: Math.floor(at / 1000) - H4, price } }, { target: want, reason: 'r', reasonKo: 'r', signals: [] });

test('paper result: the recorded targets at the recorded prices, fee on each change, from the first decision', () => {
  const a = made(NOW, null, 0.25, 2000);                 // 25%
  const b = made(NOW + AI_EVERY_MS, 0.25, 0.5, 2200);     // +10% while 25% in, then 50%
  const c = heldDecision({ at: NOW + 2 * AI_EVERY_MS, candle: 0, asset: 'ETH', prev: 0.5, model: 'm', snapshot: { ...snap, price: 1980 } }, 'invalid');
  const p = paperTrack([heldDecision({ at: NOW - AI_EVERY_MS, candle: 0, asset: 'ETH', prev: null, model: null }, 'noData'), a, b, c])!;
  const want = (1 - 0.003 * 0.25) * (1 + 0.25 * 0.1) * (1 - 0.003 * 0.25) * (1 + 0.5 * (1980 / 2200 - 1));
  assert.ok(Math.abs(p.total - (want - 1)) < 1e-12);
  assert.ok(Math.abs(p.hold - (1980 / 2000 - 1)) < 1e-12);
  assert.equal(p.since, NOW, 'starts at the first decision the model made');
  assert.equal(p.changes, 2);
  assert.equal(paperTrack([heldDecision({ at: NOW, candle: 0, asset: 'ETH', prev: null, model: null }, 'stale')]), null, 'no decision yet: no result');
});

test('the agent: a weight signal only with the AI on and a decision made; never "beats holding"', () => {
  const ds = [made(NOW, null, 0.25, 2000), made(NOW + AI_EVERY_MS, 0.25, 0.5, 2400)];
  const a = aiAgent(feed(ds));
  assert.equal(a.id, 'aiPilot-ETH');
  assert.equal(a.target, 0.5);
  assert.equal(a.band, BAND);
  assert.equal(a.runnable, true);
  assert.ok(a.total > 0 && a.total < a.hold, 'paper result vs holding');
  assert.equal(beatsHold(a), false, 'no backtest: never in a "beats holding" list');
  assert.equal(beatsHold({ ...a, total: 5, hold: 0 }), false);
  const s = agentSignal(a);
  assert.equal(s.kind, 'weight');
  assert.equal(s.decision?.ai?.reason, 'r');
  assert.equal(s.decision?.ai?.hash, ds[1].hash, 'the decision’s own hash travels in the journal');
  // The vault holds nothing: the runner asks to buy half the budget, journaled with the AI's decision.
  const h: HiredAgent = { id: 'x', createdAt: NOW, asset: 'ETH', perBuyUsd: 100, budgetUsd: 100, mode: 'auto', paused: false, fired: [], fills: [], log: [], source: { type: 'market', agentId: 'aiPilot-ETH', kind: 'position', rule: 'aiPilot', base: 'ETH' } };
  const d = decide(h, s, NOW + AI_EVERY_MS, { maxTradeUsd: 30 });
  assert.equal(d.type, 'order');
  if (d.type !== 'order') return;
  assert.equal(d.order.usd, 30, 'inside the vault’s per-trade limit');
  assert.ok(d.order.journal && verifyJournal(d.order.journal));
  assert.equal(d.order.journal!.entry.decision.ai?.hash, ds[1].hash);
  assert.equal(journalHash(d.order.journal!.entry), makeJournal(d.order.journal!.entry).hash);

  for (const state of ['noKey', 'off'] as const) {
    const x = aiAgent(feed(ds, state));
    assert.equal(x.target, undefined, `${state}: nothing to follow`);
    assert.equal(x.runnable, false, `${state}: cannot be hired`);
  }
  const fresh = aiAgent(feed([]));
  assert.equal(fresh.target, undefined, 'no decision yet: nothing to follow');
  assert.equal(fresh.total, 0);
  assert.equal(fresh.ai?.paper, null);
});
