import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { aiState, decideOnce, targetInForce, type AiDeps } from './aiPilot.ts';
import { aiFile, openAiStore } from './aiStore.ts';
import { createApi } from './api.ts';
import { issue } from './session.ts';
import { AI_EVERY_MS, verifyDecision, type AiSnapshot } from '../src/aiPilot.ts';

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
