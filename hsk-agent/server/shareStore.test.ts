import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openShares } from './shareStore.ts';
import { cleanAgent, createApi } from './api.ts';
import { openStore } from './autoStore.ts';
import { issue } from './session.ts';
import { tick, type Deps } from './autoRunner.ts';
import { fromTemplate } from '../src/spec.ts';
import { MAX_EVER_PER_WALLET, MAX_LIVE_PER_WALLET } from '../src/share.ts';
import type { HiredAgent } from '../src/runner.ts';

const MARKETS = ['BTCUSDT-PERPETUAL', 'ETHUSDT-PERPETUAL', 'HSKUSDT'];
const ANN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BOB = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CAROL = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const spec = (id = 'm1', name = 'ETH trend') => ({ id, name, market: 'ETHUSDT-PERPETUAL', ...fromTemplate('trend200')!, createdAt: 1 });

test('publishing keeps the rule, the creator given by the caller, the fee and the time', () => {
  const s = openShares(undefined, MARKETS);
  const r = s.publish(ANN, { spec: spec(), feeBps: 50, nick: 'Calm Otter' }, 1000);
  assert.ok(r.ok);
  assert.equal(r.agent.creator, ANN);
  assert.equal(r.agent.feeBps, 50);
  assert.equal(r.agent.createdAt, 1000);
  assert.equal(r.agent.spec.id, r.agent.id);
  assert.equal(r.agent.hires, 0);
  assert.deepEqual(s.list().map((a) => a.id), [r.agent.id]);
  // the same agent again gives the same link back
  const again = s.publish(ANN, { spec: spec(), feeBps: 10 });
  assert.ok(again.ok && again.again && again.agent.id === r.agent.id && again.agent.feeBps === 50);
});

test('a bad rule or fee is refused, and one wallet can share only so many', () => {
  const s = openShares(undefined, MARKETS);
  assert.deepEqual(s.publish(ANN, { spec: { ...spec(), buy: [] }, feeBps: 0 }), { ok: false, why: 'invalid' });
  assert.deepEqual(s.publish(ANN, { spec: spec(), feeBps: 101 }), { ok: false, why: 'fee' });
  assert.deepEqual(s.publish(ANN, { spec: spec(), feeBps: '50' }), { ok: false, why: 'fee' });
  for (let i = 0; i < MAX_LIVE_PER_WALLET; i++) assert.ok(s.publish(ANN, { spec: spec(`m${i}`), feeBps: 0 }).ok);
  assert.deepEqual(s.publish(ANN, { spec: spec('one-more'), feeBps: 0 }), { ok: false, why: 'tooMany' });
  assert.ok(s.publish(BOB, { spec: spec('bob'), feeBps: 0 }).ok, 'another wallet is not held up');
  // stopping one frees a place, but not forever: there is a cap on everything ever shared
  for (let i = 0; i < MAX_EVER_PER_WALLET; i++) {
    const live = s.mine(ANN).find((a) => !a.removedAt);
    if (live) s.unpublish(ANN, live.id);
    const r = s.publish(ANN, { spec: spec(`n${i}`), feeBps: 0 });
    if (!r.ok) { assert.equal(r.why, 'tooManyEver'); return; }
  }
  assert.fail('the cap on everything shared was never reached');
});

test('hires are counted once per wallet, never the creator\'s own, and never after it is stopped', () => {
  const s = openShares(undefined, MARKETS);
  const r = s.publish(ANN, { spec: spec(), feeBps: 25 });
  assert.ok(r.ok);
  const id = r.agent.id;
  assert.equal(s.hire(id, BOB)?.hires, 1);
  assert.equal(s.hire(id, BOB.toLowerCase())?.hires, 1, 'the same wallet twice is one hire');
  assert.equal(s.hire(id, ANN)?.hires, 1, 'the creator hiring their own agent does not count');
  assert.equal(s.hire(id, CAROL)?.hires, 2);
  assert.equal(s.unpublish(BOB, id), undefined, 'only the creator can stop sharing it');
  const gone = s.unpublish(ANN, id, 5000);
  assert.equal(gone?.removedAt, 5000);
  assert.deepEqual(s.list(), []);
  assert.equal(s.get(id)?.removedAt, 5000, 'the link still opens and says it was stopped');
  assert.equal(s.hire(id, '0x90F79bf6EB2c4f870365E785982E1f101E93b906')?.hires, 2);
  assert.equal(s.hire('nope', BOB), undefined);
});

test('the file survives a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'moa-share-')), 'shared.json');
  const a = openShares(file, MARKETS);
  const r = a.publish(ANN, { spec: spec(), feeBps: 100 });
  assert.ok(r.ok);
  a.hire(r.agent.id, BOB);
  const b = openShares(file, MARKETS);
  assert.equal(b.get(r.agent.id)?.hires, 1);
  assert.equal(b.get(r.agent.id)?.feeBps, 100);
});

test('an auto agent carries the creator and fee of the server\'s record, whatever the browser sent', () => {
  const s = openShares(undefined, MARKETS);
  const r = s.publish(ANN, { spec: spec(), feeBps: 50 });
  assert.ok(r.ok);
  const base = { id: 'h1', asset: 'ETH', perBuyUsd: 10, budgetUsd: 50, source: { type: 'market', agentId: `shared:${r.agent.id}`, kind: 'position', rule: 'made', base: 'ETH' }, spec: r.agent.spec };
  const forged = cleanAgent({ ...base, shared: { id: r.agent.id, creator: CAROL, feeBps: 100 } }, s);
  assert.deepEqual(forged?.shared, { id: r.agent.id, creator: ANN, feeBps: 50 });
  assert.equal(cleanAgent({ ...base, shared: { id: 'unknown', creator: CAROL, feeBps: 100 } }, s)?.shared, undefined);
});

test('the auto runner names the creator on a shared agent\'s order, and nobody on others', async () => {
  const store = openStore();
  const NOW = 1_800_000_000_000;
  const mk = (id: string, shared?: HiredAgent['shared']): HiredAgent => ({ id, createdAt: NOW - 1, asset: 'ETH', perBuyUsd: 10, budgetUsd: 100, mode: 'auto', paused: false, fired: [], fills: [], log: [], source: { type: 'market', agentId: `x-${id}`, kind: 'position', rule: 'made', base: 'ETH' }, ...(shared ? { shared } : {}) });
  store.put(ANN, mk('own'));
  store.put(ANN, mk('theirs', { id: 's1', creator: BOB, feeBps: 50 }));
  const sent: { creator?: unknown }[] = [];
  const deps: Deps = {
    status: async () => ({ configured: true, holdings: [] }),
    signal: async () => ({ kind: 'position', live: true }),
    trade: async (_o, req) => { sent.push(req); return { ok: true, txHash: '0x1', explorerUrl: '', amountIn: '10', amountOut: '0.005', tokenIn: 'USDT', tokenOut: 'WETH', block: '1' }; },
    stop: async () => ({ ok: false, reason: 'none' }),
  };
  await tick(store, deps, NOW);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((x) => x.creator).filter(Boolean), [{ address: BOB, feeBps: 50 }]);
});

/* ---------- over HTTP: the creator is the session's wallet ---------- */

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'moa-share-api-'));
  const env = { MOA_SESSION_SECRET: 'test-secret', MOA_DATA_DIR: dir };
  const api = createApi(env, { store: openStore() });
  const server = createServer((req, res) => void api.handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (who: string) => issue(env.MOA_SESSION_SECRET, who as `0x${string}`, Date.now() + 60_000);
  const call = async (path: string, who?: string, body?: unknown) => {
    const r = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(who ? { authorization: `Bearer ${token(who)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  return { call, close: () => server.close() };
}

test('over HTTP: login needed to share, creator from the session, hires counted, fees unavailable in a demo', async () => {
  const { call, close } = await serve();
  try {
    assert.equal((await call('/api/shared', undefined, { spec: spec(), feeBps: 10 })).status, 401);
    const pub = await call('/api/shared', ANN, { spec: spec(), feeBps: 10, nick: 'Ann', creator: CAROL });
    assert.equal(pub.status, 200);
    const agent = pub.json.agent as { id: string; creator: string };
    assert.equal(agent.creator, ANN, 'the creator is the logged-in wallet, not what the body says');
    assert.equal((await call(`/api/shared/${agent.id}`)).json.agent && 'ok', 'ok');
    assert.equal((await call('/api/shared/hire', BOB, { id: agent.id })).json.ok, true);
    const list = await call('/api/shared');
    assert.equal((list.json.agents as { hires: number }[])[0].hires, 1);
    assert.equal((await call('/api/shared/unpublish', BOB, { id: agent.id })).status, 404);
    const mine = await call('/api/shared/mine', ANN);
    assert.deepEqual((await call('/api/shared/fees', ANN)).json.fees, { state: 'unavailable', reason: 'demo' });
    assert.equal((await call('/api/shared/fees')).status, 401);
    assert.equal((mine.json.agents as unknown[]).length, 1);
    assert.equal((await call('/api/shared/unpublish', ANN, { id: agent.id })).status, 200);
    assert.deepEqual((await call('/api/shared')).json.agents, []);
    assert.equal((await call('/api/shared/nothing')).status, 404);
  } finally { close(); }
});
