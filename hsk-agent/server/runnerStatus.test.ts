import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { newRunnerState, tick, type Deps } from './autoRunner.ts';
import { createApi } from './api.ts';
import { openStore } from './autoStore.ts';
import { issue } from './session.ts';
import type { HiredAgent, Signal } from '../src/runner.ts';

const ANN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BOB = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const NOW = 1_800_000_000_000, DAY = 86_400_000;
const agent = (over: Partial<HiredAgent> = {}): HiredAgent => ({
  id: 'a1', createdAt: NOW - DAY, asset: 'ETH', perBuyUsd: 10, budgetUsd: 100, mode: 'auto', paused: false, fired: [], fills: [], log: [],
  source: { type: 'market', agentId: 'trend200:ETHUSDT-PERPETUAL', kind: 'position', rule: 'trend200', base: 'ETH' }, ...over,
});
const deps = (signal: Signal | Error, vault: Record<string, unknown> = {}): Deps => ({
  status: async () => ({ configured: true, holdings: [], ...vault }),
  signal: async () => { if (signal instanceof Error) throw signal; return signal; },
  trade: async () => ({ ok: false, reason: 'DailyCapExceeded' }),
  stop: async () => ({ ok: false, reason: 'not due' }),
});

test('the runner records what each auto agent decided at its last look, and why', async () => {
  const store = openStore();
  store.put(ANN, agent());
  store.put(ANN, agent({ id: 'p1', paused: true }));
  store.put(ANN, agent({ id: 'k1', mode: 'ask' }));
  const state = newRunnerState(300_000, NOW);
  await tick(store, deps({ kind: 'position', live: false }), NOW, state);
  assert.deepEqual(state.agents.get('a1'), { at: NOW, k: 'idle', signal: { kind: 'position', live: false } });
  assert.deepEqual(state.agents.get('p1'), { at: NOW, k: 'paused' });
  assert.equal(state.agents.get('k1'), undefined, 'an agent that asks first is not the runner’s');
  assert.deepEqual(state.owners.get(ANN.toLowerCase()), { at: NOW });

  // signal on: it tries to buy; the vault refuses, and the refusal is kept in plain words
  await tick(store, deps({ kind: 'position', live: true }), NOW + 1, state);
  const c = state.agents.get('a1');
  assert.equal(c?.k, 'order');
  assert.ok(c?.k === 'order' && !c.ok && c.error === 'DailyCapExceeded' && c.side === 'buy');

  await tick(store, deps(new Error('Gate timed out')), NOW + 2, state);
  assert.deepEqual(state.agents.get('a1'), { at: NOW + 2, k: 'noSignal', error: 'Gate timed out' });
  await tick(store, deps({ kind: 'position', live: true }, { paused: true }), NOW + 3, state);
  assert.deepEqual(state.agents.get('a1'), { at: NOW + 3, k: 'vaultPaused' });
});

async function serve(env: Record<string, string> = {}) {
  const store = openStore();
  store.put(ANN, agent());
  const api = createApi({ MOA_SESSION_SECRET: 'secret', MOA_DATA_DIR: mkdtempSync(join(tmpdir(), 'moa-status-')), ...env }, { store });
  const server = createServer((req, res) => void api.handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => server.close() };
}
const auth = (who: string) => ({ authorization: `Bearer ${issue('secret', who as `0x${string}`, Date.now() + 60_000)}` });

test('/api/auto/status: the runner is public; each wallet sees only its own agents', async () => {
  const { url, close } = await serve();
  try {
    const anon = await (await fetch(`${url}/api/auto/status`)).json() as Record<string, unknown>;
    assert.deepEqual(anon.runner, { on: false, why: 'demo' });
    assert.equal(anon.agents, undefined);
    const ann = await (await fetch(`${url}/api/auto/status`, { headers: auth(ANN) })).json() as { agents: { id: string }[] };
    assert.deepEqual(ann.agents.map((a) => a.id), ['a1']);
    const bob = await (await fetch(`${url}/api/auto/status?owner=${ANN}`, { headers: auth(BOB) })).json() as Record<string, unknown>;
    assert.equal(bob.agents, undefined, "Bob cannot read Ann's agents");
  } finally { close(); }
});

test('/api/moa/propose: a login, a real order and a vault, or no ticket', async () => {
  const { url, close } = await serve();
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/api/moa/propose`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ asset: 'BTC', side: 'buy', amount: 1 })).status, 401);
    assert.equal((await post({ asset: 'DOGE', side: 'buy', amount: 1 }, auth(ANN))).status, 400);
    assert.equal((await post({ asset: 'BTC', side: 'buy', amount: -1 }, auth(ANN))).status, 400);
    const r = await post({ asset: 'BTC', side: 'buy', amount: 1 }, auth(ANN));
    assert.equal(r.status, 409, 'a demo server has no vault to send from');
    assert.equal(((await r.json()) as { why: string }).why, 'noVault');
  } finally { close(); }
});
