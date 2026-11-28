import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { AI_SYSTEM, FLOW_MAX_MS, POOL_RECORD_MAX_MS, aiState, decideOnce, flowInput, poolInput, poolRead, targetInForce, type AiDeps } from './aiPilot.ts';
import { aiFile, openAiStore } from './aiStore.ts';
import { createApi } from './api.ts';
import { issue } from './session.ts';
import { AI_EVERY_MS, BAND, CUT, STEP, verifyDecision, type AiSnapshot } from '../src/aiPilot.ts';
import { POOL_FEE, TAKER_FEE, roundTrip, type GapPoint } from '../src/spread.ts';
import { viewOf } from '../src/onchain.ts';
import type { PoolState } from '../src/depth.ts';

const H4 = AI_EVERY_MS / 1000;
const T0 = 1_799_971_200;                 // a 4-hour boundary (08:00 UTC)
const NOW = (T0 + 5 * 60) * 1000;         // five minutes after the 04:00 candle closed
const candle = T0 - H4;
const snap = (c = candle): AiSnapshot => ({ asset: 'BTC', candle: c, price: 100_000, ret7d: 0.04, vol20: 0.45 });
const answer = (target: number) => JSON.stringify({ target, reason: 'Up 4% on the week; volatility 45%.', reason_ko: '한 주에 4% 올랐고 변동성은 45%예요.', signals: ['ret7d', 'vol20'] });

/** A stand-in market and model that count the calls. */
function fake(over: Partial<AiDeps> & { out?: unknown } = {}) {
  const calls = { snapshot: 0, ask: 0 };
  const deps: AiDeps = {
    snapshot: async (_a, prev) => { calls.snapshot++; return { ok: true, snap: { ...snap(), ...(prev !== null ? { prevTarget: prev } : {}) } }; },
    ask: async () => { calls.ask++; return { model: 'claude-sonnet-5-5', output: over.out ?? answer(0.6) }; },
    ...over,
  };
  return { deps, calls };
}

test('one model call per closed candle; the cool-down holds until the next one', async () => {
  const store = openAiStore();
  const { deps, calls } = fake();
  const d = await decideOnce('BTC', store, deps, NOW);
  assert.ok(d && !d.held);
  assert.equal(d.target, 0.25, 'first decision: from nothing held, at most 25 points');
  assert.equal(d.proposed, 0.6);
  assert.equal(verifyDecision(d), true);
  assert.equal(await decideOnce('BTC', store, deps, NOW + 5 * 60_000), null, 'same candle: nothing');
  assert.equal(calls.ask, 1);
  // The next candle: allowed, and it moves another 25 points from the target in force.
  const next = fake({ snapshot: async () => ({ ok: true, snap: snap(candle + H4) }) });
  const d2 = await decideOnce('BTC', store, next.deps, NOW + AI_EVERY_MS);
  assert.equal(d2?.target, 0.5);
  assert.equal(d2?.prev, 0.25);
  assert.equal(targetInForce(store.list('BTC')), 0.5);
});

test('fail-safe: every failure keeps the previous target and records why', async () => {
  const cases: [string, Partial<AiDeps> & { out?: unknown }, string][] = [
    ['call fails', { ask: async () => { throw new Error('529 overloaded'); } }, 'callFailed'],
    ['call is late', { callMs: 20, ask: (_s, signal) => new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('Request was aborted.')))) }, 'timeout'],
    ['model declines', { ask: async () => ({ model: 'claude-sonnet-5-5', refusal: true, output: null }) }, 'refusal'],
    ['answer out of form', { out: '{"target":"most of it"}' }, 'invalid'],
    ['answer not JSON', { out: 'I think 60%.' }, 'invalid'],
  ];
  for (const [name, over, why] of cases) {
    const store = openAiStore();
    // A target of 50% is in force from the candle before.
    await decideOnce('BTC', store, fake({ snapshot: async () => ({ ok: true, snap: snap(candle - H4) }), out: answer(0.25) }).deps, NOW - AI_EVERY_MS);
    await decideOnce('BTC', store, fake({ snapshot: async () => ({ ok: true, snap: snap(candle - H4) }), out: answer(0.25) }).deps, NOW - AI_EVERY_MS);
    const before = targetInForce(store.list('BTC'));
    assert.equal(before, 0.25, name);
    const d = await decideOnce('BTC', store, fake(over).deps, NOW);
    assert.equal(d?.held, why, name);
    assert.equal(d?.target, before, `${name}: target kept`);
    assert.ok(d?.reason && d.reasonKo, `${name}: the reason is said`);
    assert.equal(d?.model !== null, true, `${name}: a call was made, so the candle is done`);
    assert.equal(await decideOnce('BTC', store, fake().deps, NOW + 60_000), null, `${name}: no second call for this candle`);
  }
});

test('fail-safe: old or missing data holds without a call, said once, and retried quietly', async () => {
  const store = openAiStore();
  const stale = fake({ snapshot: async () => ({ ok: false, why: 'stale' }) });
  const d = await decideOnce('BTC', store, stale.deps, NOW);
  assert.equal(d?.held, 'stale');
  assert.equal(d?.model, null);
  assert.equal(d?.target, 0, 'nothing decided yet: nothing held');
  assert.equal(stale.calls.ask, 0, 'no model call on old data');
  assert.equal(await decideOnce('BTC', store, stale.deps, NOW + 5 * 60_000), null, 'the same hold is not recorded twice');
  assert.equal(store.list('BTC').length, 1);
  const broken = fake({ snapshot: async () => { throw new Error('HashKey unreachable'); } });
  assert.equal((await decideOnce('BTC', store, broken.deps, NOW + 10 * 60_000))?.held, 'noData');
  // The data is back within the same candle: the decision is made then.
  const ok = fake();
  const d2 = await decideOnce('BTC', store, ok.deps, NOW + 15 * 60_000);
  assert.equal(d2?.held, undefined);
  assert.equal(ok.calls.ask, 1);
  assert.equal(targetInForce(store.list('BTC')), 0.25);
});

test('a candle the exchange has not published yet is waited for, not skipped', async () => {
  const store = openAiStore();
  const early = fake({ snapshot: async () => ({ ok: true, snap: snap(candle - H4) }) });
  assert.equal(await decideOnce('BTC', store, early.deps, NOW), null);
  assert.equal(early.calls.ask, 0);
  assert.equal(store.list('BTC').length, 0);
});

test('kill switch and no key: off, with the reason', () => {
  assert.equal(aiState({ ANTHROPIC_API_KEY: 'k' }), 'on');
  assert.equal(aiState({ ANTHROPIC_API_KEY: 'k', MOA_AI_TRADER: 'off' }), 'off');
  assert.equal(aiState({ ANTHROPIC_API_KEY: 'k', MOA_AI_TRADER: 'OFF' }), 'off');
  assert.equal(aiState({}), 'noKey');
  assert.equal(aiState({ MOA_AI_TRADER: 'off' }), 'off');
});

test('decisions persist in MOA_DATA_DIR and come back after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moa-ai-'));
  const file = aiFile({ MOA_DATA_DIR: dir });
  const d = await decideOnce('ETH', openAiStore(file), fake().deps, NOW);
  const again = openAiStore(file);
  assert.deepEqual(again.list('ETH'), [d]);
  assert.equal(verifyDecision(again.list('ETH')[0]), true, 'the hash still checks after the round trip through the file');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).ETH.length === 1);
  const f = again.feed('ETH', 'on', 'claude-sonnet-5-5', 10);
  assert.equal(f.count, 1);
  assert.equal(f.paper?.since, NOW);
});

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
test('the API: public decisions; with no key the AI says so and cannot go on auto', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moa-ai-api-'));
  const ai = openAiStore(aiFile({ MOA_DATA_DIR: dir }));
  await decideOnce('HSK', ai, fake().deps, NOW);
  const api = createApi({ MOA_SESSION_SECRET: 'secret', MOA_DATA_DIR: dir }, { ai });
  const server = createServer((req, res) => void api.handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await (await fetch(`${url}/api/ai/decisions?asset=HSK`)).json() as { state: string; decisions: { hash: string; reason: string; target: number }[]; model: string | null };
    assert.equal(r.state, 'noKey');
    assert.equal(r.model, null);
    assert.equal(r.decisions.length, 1);
    assert.match(r.decisions[0].hash, /^0x[0-9a-f]{64}$/);
    assert.equal((await fetch(`${url}/api/ai/decisions?asset=DOGE`)).status, 400);
    const hire = await fetch(`${url}/api/auto`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${issue('secret', OWNER, Date.now() + 60_000)}` },
      body: JSON.stringify({ agent: { id: 'ai1', asset: 'HSK', perBuyUsd: 100, budgetUsd: 100, source: { type: 'market', agentId: 'aiPilot-HSK', kind: 'position', rule: 'aiPilot', base: 'HSK' } } }),
    });
    assert.equal(hire.status, 409);
    assert.equal(((await hire.json()) as { why: string }).why, 'aiOff');
  } finally { server.close(); }
});

/* ---------- the pool and the flow: retried, then the server's own record, then said to be missing ---------- */

const STATE: PoolState = { sqrtPrice: 1, tick: 0, liquidity: 1e12, ticks: [] };
const fresh = (over: Partial<GapPoint> = {}) => ({ point: { t: NOW, pool: 99, hk: 100, ...over } as GapPoint, state: STATE });

test('the pool read is tried again when it comes back empty, not only when it throws', async () => {
  let n = 0;
  const r = await poolRead('BTC', NOW, async () => (++n === 1 ? null : fresh()), 5);
  assert.equal(n, 2, 'readNow returns null on a failed pool read: that is retried too');
  assert.equal(r?.point.pool, 99);
  n = 0;
  assert.equal(await poolRead('BTC', NOW, async () => { n++; throw new Error('RPC down'); }, 5), null);
  assert.equal(n, 2, 'a throw is retried once as before');
  n = 0;
  assert.equal(await poolRead('BTC', NOW, async () => { n++; return { point: { t: NOW, pool: 99 }, state: STATE }; }, 5), null, 'a pool price with no exchange price to compare is not a read');
  assert.equal(n, 2);
  n = 0;
  const t0 = Date.now();
  assert.equal(await poolRead('BTC', NOW, () => { n++; return new Promise(() => {}); }, 5, 20), null, 'a read that never comes back is given up');
  assert.ok(n === 2 && Date.now() - t0 < 500);
});

test('pool inputs: a read made now; else the last recorded gap with its age; else nothing', () => {
  const live = poolInput('BTC', fresh(), [], NOW)!;
  assert.ok(Math.abs(live.gap - (99 / 100 - 1)) < 1e-12);
  assert.equal(live.ageMin, undefined, 'read now: no age');
  assert.ok(live.depth2pct !== undefined);
  // the read failed: the newest record that has an exchange price, 20 minutes old
  const rec: GapPoint[] = [
    { t: NOW - 50 * 60_000, pool: 90, hk: 100, buy: 0.001, sell: 0.002 },
    { t: NOW - 20 * 60_000, pool: 99, hk: 100, buy: 0.001, sell: 0.002 },
    { t: NOW - 5 * 60_000, pool: 98 },                    // the exchanges did not answer: no gap in it
  ];
  const old = poolInput('BTC', null, rec, NOW)!;
  assert.equal(old.price, 99);
  assert.equal(Math.round(old.ageMin!), 20);
  assert.ok(Math.abs(old.gap - -0.01) < 1e-12);
  assert.ok(Math.abs(old.net100! - (100 / 99 - 1 - POOL_FEE - TAKER_FEE - 0.001)) < 1e-12, 'the same sum as a live spread, with the recorded slip');
  assert.equal(old.roundTrip, roundTrip(rec[1]));
  assert.equal(old.depth2pct, undefined, 'a record has no depth: not guessed');
  // dearer on the pool: the sell slip, and no round trip (as in a live spread)
  const dear = poolInput('BTC', null, [{ t: NOW - 60_000, pool: 101, gate: 100, buy: 0.001, sell: 0.002 }], NOW)!;
  assert.ok(Math.abs(dear.net100! - (0.01 - POOL_FEE - TAKER_FEE - 0.002)) < 1e-12);
  assert.equal(dear.roundTrip, undefined);
  assert.equal(poolInput('BTC', null, [{ t: NOW - POOL_RECORD_MAX_MS - 1, pool: 99, hk: 100 }], NOW), null, 'too old a record is not used');
  assert.equal(poolInput('BTC', null, [], NOW), null);
});

test('flow inputs come with the age of the on-chain reading; the week only once 7 days are read', () => {
  const DAY = 86_400_000, at = NOW - 9 * 60_000;
  const swaps = [{ block: 1, time: at - 3_600_000, side: 'buy' as const, usdt: 300, price: 0.08, tx: '0x1' }, { block: 2, time: at - 3 * DAY, side: 'sell' as const, usdt: 100, price: 0.08, tx: '0x2' }];
  const young = flowInput(viewOf('HSK', swaps, at - 2 * DAY, [], at), NOW)!;
  assert.deepEqual([young.net24h, young.swaps24h, Math.round(young.ageMin!), 'net7d' in young], [300, 1, 9, false]);
  const full = flowInput(viewOf('HSK', swaps, at - 30 * DAY, [], at), NOW)!;
  assert.equal(full.net7d, 200);
  assert.equal(flowInput(null, NOW), null);
  assert.equal(flowInput(viewOf('HSK', swaps, at - 30 * DAY, [], NOW - FLOW_MAX_MS - 1), NOW), null, 'a reading hours old is not passed off as now');
});

test('a failed call records its kind; the feed, and through it /api/health, say the AI is failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moa-ai-fail-'));
  const ai = openAiStore(aiFile({ MOA_DATA_DIR: dir }));
  const noCredit = Object.assign(new Error('400 credit balance is too low'), { status: 400, error: { error: { type: 'invalid_request_error' } } });
  const d = await decideOnce('BTC', ai, fake({ ask: async () => { throw noCredit; }, snapshot: async () => ({ ok: true, snap: { ...snap(), missing: ['pool'] } }) }).deps, NOW);
  assert.deepEqual([d?.held, d?.fail, d?.missing], ['callFailed', '400 invalid_request_error', ['pool']]);
  assert.equal(verifyDecision(d!), true);
  assert.deepEqual(ai.feed('BTC', 'on', 'm').trouble, { held: 'callFailed', kind: '400 invalid_request_error', at: NOW });
  assert.equal(ai.feed('BTC', 'noKey', null).trouble, undefined, 'an AI that is off is off, not failing');
  assert.equal(ai.feed('ETH', 'on', 'm').trouble, undefined);
  // a data hold after it (no call made) does not hide that the last call failed
  await decideOnce('BTC', ai, fake({ snapshot: async () => ({ ok: false, why: 'stale' }) }).deps, NOW + AI_EVERY_MS);
  assert.equal(ai.feed('BTC', 'on', 'm').trouble?.kind, '400 invalid_request_error');

  const serve = async (env: Record<string, string>, store = ai) => {
    const api = createApi({ MOA_SESSION_SECRET: 'secret', MOA_DATA_DIR: dir, ...env }, { ai: store });
    const server = createServer((req, res) => void api.handler(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const get = async (path: string) => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`)).json() as Promise<Record<string, unknown>>;
    return { get, close: () => server.close() };
  };
  // Date.now() is far from NOW in this test, so the failed decision is made "now" for the health check.
  const live = openAiStore();
  const now = Date.now(), c = Math.floor(now / AI_EVERY_MS) * H4 - H4;
  await decideOnce('BTC', live, fake({ ask: async () => { throw noCredit; }, snapshot: async () => ({ ok: true, snap: snap(c) }) }).deps, now);
  const failing = await serve({ ANTHROPIC_API_KEY: 'test-key-not-real' }, live);
  const fine = await serve({ ANTHROPIC_API_KEY: 'test-key-not-real' }, openAiStore());
  const off = await serve({}, live);
  try {
    assert.equal((await failing.get('/api/health')).ai, 'failing', 'a key is set, but the last call failed');
    assert.deepEqual(Object.keys(await failing.get('/api/health')).sort(), ['ai', 'factory', 'ok', 'vaults'], 'and nothing else is added to the public health');
    assert.deepEqual((await failing.get('/api/ai/decisions?asset=BTC')).trouble, { held: 'callFailed', kind: '400 invalid_request_error', at: now });
    assert.equal((await fine.get('/api/health')).ai, 'on');
    assert.equal((await off.get('/api/health')).ai, 'off');
  } finally { failing.close(); fine.close(); off.close(); }
});

test('the prompt the model reads states the limits the code applies', () => {
  assert.match(AI_SYSTEM, new RegExp(`raises the share at most ${STEP * 100} points per decision, lowers it at most ${CUT * 100} points per decision`));
  assert.match(AI_SYSTEM, new RegExp(`ignores changes under ${BAND * 100} points`));
  assert.match(AI_SYSTEM, /missing: input groups that could not be read/);
});

test('cuts move faster than buys through a whole decision, and each decision keeps its limits', async () => {
  const store = openAiStore();
  const at = (k: number) => ({ snapshot: async () => ({ ok: true as const, snap: snap(candle + k * H4) }) });
  for (let k = 0; k < 4; k++) await decideOnce('BTC', store, fake({ ...at(k), out: answer(1) }).deps, NOW + k * AI_EVERY_MS);
  assert.equal(targetInForce(store.list('BTC')), 1, 'four decisions to get to 100%');
  const d1 = await decideOnce('BTC', store, fake({ ...at(4), out: answer(0) }).deps, NOW + 4 * AI_EVERY_MS);
  const d2 = await decideOnce('BTC', store, fake({ ...at(5), out: answer(0) }).deps, NOW + 5 * AI_EVERY_MS);
  assert.deepEqual([d1?.target, d2?.target], [0.5, 0], 'two to get out');
  assert.deepEqual(d1?.limits, { band: BAND, step: STEP, cut: CUT });
  assert.deepEqual(d1?.guard, { stepped: true });
});
