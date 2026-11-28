import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_EVERY_MS, BAND, COOLDOWN_MS, aiAgent, buildSnapshot, decisionHash, forModel, guard, heldDecision, isDue, lastClosedCandle, madeDecision,
  paperTrack, parseOutput, plain, verifyDecision, type AiDecision, type AiFeed, type AiSnapshot,
} from './aiPilot.ts';
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
  assert.equal(guard(0.5, -3).target, 0.25);
  assert.equal(guard(0.8, 0.98).target, 1, 'rounded to 1.0: a 20-point move, within the step and above the band');
  assert.equal(guard(0.8, 1.02).target, 1);
  assert.equal(guard(0.4, 0.62).target, 0.6, '0.62 rounds to 0.60');
  assert.equal(guard(0.4, 0.63).target, 0.65, '0.63 rounds to 0.65');
});
test('guard: at most 25 points a decision, from nothing held at the start', () => {
  assert.deepEqual(guard(null, 1), { target: 0.25, guard: { stepped: true } });
  assert.equal(guard(0.25, 1).target, 0.5);
  assert.equal(guard(1, 0).target, 0.75);
  assert.equal(guard(0.6, 0).target, 0.35);
});
test('guard: a move under 15 points is no move', () => {
  assert.deepEqual(guard(0.5, 0.6), { target: 0.5, guard: { banded: true } });
  assert.deepEqual(guard(0.5, 0.4), { target: 0.5, guard: { banded: true } });
  assert.equal(guard(0.5, 0.65).target, 0.65, 'exactly the band moves');
  assert.equal(guard(null, 0.1).target, 0, 'a first 10% stays at nothing');
  assert.deepEqual(guard(0.5, 0.5), { target: 0.5, guard: {} });
  assert.equal(BAND, 0.15);
});

test('cool-down: one decision per closed 4-hour candle, never sooner than the interval', () => {
  const candle = lastClosedCandle(NOW);
  assert.equal(candle, T0 - H4, 'the 04:00 candle closed at 08:00');
  assert.equal(isDue(undefined, candle, NOW), true);
  assert.equal(isDue({ at: NOW - 60_000, candle }, candle, NOW), false, 'that candle is decided');
  assert.equal(isDue({ at: NOW - 60_000, candle: candle - H4 }, candle, NOW), false, 'a new candle, but the last decision was a minute ago');
  assert.equal(isDue({ at: NOW - COOLDOWN_MS, candle: candle - H4 }, candle, NOW), true);
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
  for (const [k, v] of Object.entries(s)) if (k !== 'asset') assert.equal(typeof v, 'number', `${k} is a number`);
  const withPool = buildSnapshot({ asset: 'HSK', now: NOW, daily: d, h4: h4(T0, 400), prevTarget: null, pool: { price: 398, gap: -0.005, roundTrip: 0.0071, depth2pct: 12000 }, flow: { net24h: -1200, buy24h: 800, sell24h: 2000, swaps24h: 31, net7d: 400 } });
  assert.ok(withPool.ok);
  assert.equal(withPool.snap.poolGap, -0.005);
  assert.equal(withPool.snap.flowSwaps24h, 31);
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
