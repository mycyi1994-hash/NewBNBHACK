// Moving a wallet to a new vault, on the server: what /api/vault says about it, what POST /api/vault/upgrade does
// short of sending a transaction, the agents on auto, and where a creator fee may be asked. The chain here is a
// stand-in JSON-RPC server that answers the calls the executor makes from a small model of factories, vaults and
// balances; the real thing (transactions included) is rehearsed in contracts/scripts/upgrade-fork-test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { decodeFunctionData, encodeFunctionResult, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import vaultArtifact from '../contracts/out/MoaVault.json' with { type: 'json' };
import factoryArtifact from '../contracts/out/MoaVaultFactory.json' with { type: 'json' };
import { factoryVersion, feesLive, forOwner, moveStatus, upgradeVault, vaultVersion, vaultView, TOKENS, USDT, type ExecConfig } from './executor.ts';
import { newRunnerState, pauseForMove, tick, undoMovePause, type Deps } from './autoRunner.ts';
import { createApi } from './api.ts';
import { openStore } from './autoStore.ts';
import { issue } from './session.ts';
import { fromTemplate } from '../src/spec.ts';
import type { HiredAgent } from '../src/runner.ts';

const ANN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';    // has a version-2 vault
const BOB = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';    // never had a vault
// Hardhat's well-known local test key #1 (public, never funded on any real chain): the server needs some agent key.
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const AGENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const F3 = '0x00000000000000000000000000000000000000f3', F2 = '0x00000000000000000000000000000000000000f2', F2B = '0x00000000000000000000000000000000000002fb';
const OLD = '0x0000000000000000000000000000000000000a02', NEW = '0x0000000000000000000000000000000000000a03', OLDER = '0x0000000000000000000000000000000000000a01';
const WBTC = TOKENS.BTC.address;
const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const abi = [...vaultArtifact.abi, ...factoryArtifact.abi, ...erc20] as Abi;
const low = (a: string) => a.toLowerCase();

interface World {
  /** each factory: the version of vault it makes, and the vault it made for each owner */
  factories: Record<string, { makes: 2 | 3; vaults: Record<string, Address> }>;
  vaults: Record<string, { version: 2 | 3; factory: string; owner: string }>;
  /** token → holder → amount in base units */
  balances: Record<string, Record<string, bigint>>;
  down?: boolean;
  createReverts?: boolean;
  calls: number;
}
const world = (over: Partial<World> = {}): World => ({
  factories: { [F3]: { makes: 3, vaults: {} }, [F2]: { makes: 2, vaults: { [low(ANN)]: OLD } } },
  vaults: { [OLD]: { version: 2, factory: F2, owner: ANN }, [NEW]: { version: 3, factory: F3, owner: ANN } },
  balances: { [low(USDT)]: { [OLD]: 9_000_000n } },
  calls: 0, ...over,
});

/** One eth_call against the model: the encoded answer, or null for "the contract has no such thing" (a revert). */
function answer(w: World, to: string, data: Hex): Hex | null {
  let f: string, args: readonly unknown[];
  try { const d = decodeFunctionData({ abi, data }); f = d.functionName; args = d.args ?? []; } catch { return null; }
  const out = (result: unknown, from: Abi = abi) => encodeFunctionResult({ abi: from, functionName: f, result } as never);
  const factory = w.factories[low(to)];
  if (factory) {
    if (f === 'vaultOf') return out(factory.vaults[low(String(args[0]))] ?? zeroAddress);
    if (f === 'tradeTerms') return factory.makes >= 3 ? out([false, 0, zeroAddress]) : null;
    if (f === 'stopLossBps') return out(1500);
    if (f === 'createVault') return w.createReverts ? null : out(NEW);
    return null;
  }
  if (f === 'balanceOf') return out(w.balances[low(to)]?.[low(String(args[0]))] ?? 0n, erc20 as unknown as Abi);
  const v = w.vaults[low(to)];
  if (!v) return null;
  const held = (token: unknown) => w.balances[low(String(token))]?.[low(to)] ?? 0n;
  switch (f) {
    case 'VERSION': return v.version >= 3 ? out(3) : null;
    // a holding is worth $60,000 a coin here, and cost what it is worth
    case 'position': { const worth = (held(args[0]) * 60_000n) / 100n; return out([held(args[0]), worth, worth, 0n]); }
    case 'maxTradeUsdt': case 'sessionMaxTradeUsdt': return out(50_000_000n);
    case 'maxDailyUsdt': case 'remainingToday': return out(100_000_000n);
    case 'maxSlippageBps': return out(150);
    case 'stopLossBps': return out(v.version >= 3 ? 1500 : 0);
    case 'paused': case 'budgetsOn': return out(false);
    case 'sessionAllows': return out(true);
    case 'factory': return out(v.factory);
    case 'owner': return out(v.owner);
    case 'agent': return out(AGENT);
    case 'agentUntil': return out(2_000_000_000n);
    case 'platformFeeAccepted': return out(0);
    default: return null;
  }
}

/** The stand-in chain over HTTP. `down` makes it fail like a node that is not there. */
async function chain(w: World) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (w.down) { res.statusCode = 503; return res.end('down'); }
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: [{ to: string; data: Hex }] };
      w.calls++;
      const reply = (body: object) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, ...body })); };
      if (method === 'eth_chainId') return reply({ result: '0xb1' });
      if (method === 'eth_getCode') {
        // code as the server reads it: a contract's functions show as their selectors (VERSION() and tradeTerms() from version 3)
        const at = low(params[0] as unknown as string), f = w.factories[at], v = w.vaults[at];
        return reply({ result: f ? `0x60${f.makes >= 3 ? 'bba21f1b' : ''}` : v ? `0x60${v.version >= 3 ? 'ffa1ad74' : ''}` : '0x' });
      }
      if (method === 'eth_blockNumber') return reply({ result: '0x10' });
      if (method !== 'eth_call') return reply({ error: { code: -32601, message: `no ${method} here` } });
      const result = answer(w, params[0].to, params[0].data);
      return result ? reply({ result }) : reply({ error: { code: 3, message: 'execution reverted', data: '0x' } });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cfg: ExecConfig = { rpcUrl, chainId: 177, factory: F3, legacyFactories: [F2], agentKey: AGENT_KEY, explorer: 'https://x', minOutBufferBps: 100, maxVaultsPerDay: 20 };
  return { rpcUrl, cfg, close: () => server.close() };
}
const moved = (w: World) => { w.factories[F3].vaults[low(ANN)] = NEW; };

test('a wallet whose vault an earlier factory made is offered the move; its vault stays the active one', async () => {
  const w = world();
  const { cfg, close } = await chain(w);
  try {
    const mine = await forOwner(cfg, ANN);
    assert.equal(mine.vault, OLD);
    assert.deepEqual(await moveStatus(mine), { upgrade: { available: true, to: 3 }, moved: false });
    const view = await vaultView(mine);
    assert.ok(view.configured && view.version === 2 && view.vault === OLD && view.upgrade?.available && view.creatorFees === true);
  } finally { close(); }
});

test('after the move the new vault is the active one, and the old one is reported for as long as it holds anything', async () => {
  const w = world();
  w.balances[low(WBTC)] = { [OLD]: 33_712n };
  moved(w);
  const { cfg, close } = await chain(w);
  try {
    const mine = await forOwner(cfg, ANN);
    assert.equal(mine.vault, NEW);
    const s = await moveStatus(mine);
    assert.deepEqual(s.upgrade, { available: false });
    assert.equal(s.moved, true);
    assert.deepEqual(s.old, {
      vault: OLD, version: 2, explorerUrl: `https://x/address/${OLD}`, usdtBalance: '9',
      holdings: [{ symbol: 'WBTC', address: WBTC, decimals: 8, amount: '0.00033712', valueUsdt: '20.2272' }], totalUsdt: '29.2272',
    });
    const view = await vaultView(mine);
    assert.ok(view.configured && view.version === 3 && view.vault === NEW);
    // the USDT is taken out: the coin alone keeps it reported
    w.balances[low(USDT)][OLD] = 0n;
    assert.equal((await moveStatus(mine)).old?.usdtBalance, '0');
    assert.equal((await moveStatus(mine)).old?.totalUsdt, '20.2272');
    // one unit of dust is still something
    w.balances[low(WBTC)][OLD] = 1n;
    assert.equal((await moveStatus(mine)).old?.holdings[0].amount, '0.00000001');
    // empty: no longer reported, and the wallet still counts as moved
    w.balances[low(WBTC)][OLD] = 0n;
    assert.deepEqual(await moveStatus(mine), { upgrade: { available: false }, moved: true });
  } finally { close(); }
});

test('an old vault that cannot say what a coin is worth is still reported, with the amount', async () => {
  const w = world();
  w.balances[low(WBTC)] = { [OLD]: 5_000n };
  delete w.vaults[OLD];   // nothing on this vault answers (a contract this server does not know)
  moved(w);
  const { cfg, close } = await chain(w);
  try {
    const s = await moveStatus(await forOwner(cfg, ANN));
    assert.deepEqual(s.old?.holdings, [{ symbol: 'WBTC', address: WBTC, decimals: 8, amount: '0.00005' }]);
    assert.equal(s.old?.totalUsdt, '9', 'only what is known is added up');
  } finally { close(); }
});

test('a wallet with no earlier vault, or a server with no earlier factory, is told nothing about moving', async () => {
  const w = world();
  w.factories[F3].vaults[low(BOB)] = NEW;
  const { cfg, close } = await chain(w);
  try {
    assert.deepEqual(await moveStatus(await forOwner(cfg, BOB)), { upgrade: { available: false }, moved: false });
    assert.deepEqual(await moveStatus(await forOwner(cfg, '0x90F79bf6EB2c4f870365E785982E1f101E93b906')), { upgrade: { available: false }, moved: false }, 'no vault at all');
    const before = w.calls;
    assert.deepEqual(await moveStatus({ ...cfg, legacyFactories: [], owner: ANN, vault: NEW }), { upgrade: { available: false }, moved: false });
    assert.deepEqual(await moveStatus({ ...cfg, owner: undefined }), { upgrade: { available: false }, moved: false });
    assert.equal(w.calls, before, 'and it costs no call to the chain');
  } finally { close(); }
});

test('no move is offered when the current factory makes nothing newer; creator fees follow what it makes', async () => {
  const w = world({ factories: { [F2B]: { makes: 2, vaults: {} }, [F2]: { makes: 2, vaults: { [low(ANN)]: OLD } } } });
  const { cfg, close } = await chain(w);
  try {
    const same = { ...cfg, factory: F2B as Address };
    assert.equal(await factoryVersion(same), 2);
    assert.equal((await moveStatus(await forOwner(same, ANN))).upgrade.available, false);
    assert.equal(await feesLive(same), false, 'version-2 vaults cannot pay a creator');
    assert.equal(await feesLive({ ...cfg, factory: undefined }), false, 'a demo has no vaults at all');
    const r = await upgradeVault(same, ANN);
    assert.ok(!r.ok && r.why === 'same');
  } finally { close(); }
  const w3 = world();
  const three = await chain(w3);
  try { assert.equal(await feesLive(three.cfg), true); } finally { three.close(); }
});

test('a chain that does not answer is "unknown", never "old": nothing is kept from it', async () => {
  const w = world({ down: true });
  const { cfg, close } = await chain(w);
  try {
    assert.equal(await factoryVersion(cfg), undefined);
    assert.equal(await feesLive(cfg), false, 'unknown shows no fee picker');
    assert.equal(await vaultVersion(cfg, NEW), 2, 'this once it reads as the older kind');
    w.down = false;
    assert.equal(await factoryVersion(cfg), 3, 'the next answer is the real one');
    assert.equal(await vaultVersion(cfg, NEW), 3);
    assert.equal(await vaultVersion(cfg, OLD), 2);
  } finally { close(); }
});

test('with two earlier factories, money in the oldest vault is not lost from view', async () => {
  const w = world();
  w.factories[F2B] = { makes: 2, vaults: { [low(ANN)]: OLDER } };
  w.vaults[OLDER] = { version: 2, factory: F2B, owner: ANN };
  w.balances[low(USDT)] = { [OLDER]: 4_000_000n };   // the newer of the two old vaults is empty
  const { cfg, close } = await chain(w);
  try {
    const s = await moveStatus(await forOwner({ ...cfg, legacyFactories: [F2, F2B] }, ANN));
    assert.equal(s.upgrade.available, true, 'the active vault is the one from the first earlier factory');
    assert.equal(s.old?.vault, OLDER);
    assert.equal(s.old?.usdtBalance, '4');
  } finally { close(); }
});

test('upgradeVault sends nothing when there is nothing to do, and says why', async () => {
  const w = world();
  const { cfg, close } = await chain(w);
  try {
    const none = await upgradeVault(cfg, BOB);
    assert.ok(!none.ok && none.why === 'nothing');
    const off = await upgradeVault({ ...cfg, agentKey: undefined }, ANN);
    assert.ok(!off.ok && off.why === 'off');
    const self = await upgradeVault(cfg, AGENT);
    assert.ok(!self.ok && self.why === 'off', 'the agent wallet cannot own a vault');
    w.createReverts = true;
    const failed = await upgradeVault(cfg, ANN);
    assert.ok(!failed.ok && failed.why === 'failed', JSON.stringify(failed));
    // the wallet already has its new vault: the same answer every time, no transaction
    moved(w);
    assert.deepEqual(await upgradeVault(cfg, ANN), { ok: true, vault: NEW, made: false, from: OLD });
    assert.deepEqual(await upgradeVault(cfg, ANN), { ok: true, vault: NEW, made: false, from: OLD });
  } finally { close(); }
});

/* ---------- the agents that work on their own ---------- */

const NOW = 1_800_000_000_000, DAY = 86_400_000;
const agent = (over: Partial<HiredAgent> = {}): HiredAgent => ({
  id: 'a1', createdAt: NOW - DAY, asset: 'ETH', perBuyUsd: 10, budgetUsd: 100, mode: 'auto', paused: false, fired: [], fills: [], log: [],
  source: { type: 'market', agentId: 'trend200:ETHUSDT-PERPETUAL', kind: 'position', rule: 'trend200', base: 'ETH' }, ...over,
});

test('a move pauses the wallet\'s agents on auto, with the reason, and leaves the rest alone', () => {
  const store = openStore();
  store.put(ANN, agent());
  store.put(ANN, agent({ id: 'p1', paused: true }));      // paused by its owner long ago
  store.put(ANN, agent({ id: 'k1', mode: 'ask' }));       // asks first: the owner answers each order
  store.put(BOB, agent({ id: 'b1' }));                    // another wallet
  assert.deepEqual(pauseForMove(store, ANN, NOW), ['a1']);
  const of = (owner: string, id: string) => store.list(owner).find((a) => a.id === id)!;
  assert.ok(of(ANN, 'a1').paused && of(ANN, 'a1').pausedWhy === 'moved');
  assert.deepEqual(of(ANN, 'a1').log.at(-1), { at: NOW, k: 'paused' });
  assert.ok(of(ANN, 'p1').paused && of(ANN, 'p1').pausedWhy === undefined);
  assert.ok(!of(ANN, 'k1').paused && !of(BOB, 'b1').paused);
  assert.deepEqual(pauseForMove(store, ANN, NOW + 1), [], 'asking again pauses nothing more');
});

test('if the new vault is not made, the agents go back exactly as they were', () => {
  const store = openStore();
  store.put(ANN, agent({ log: [{ at: 1, k: 'hired', to: { perBuyUsd: 10, budgetUsd: 100 } }] }));
  store.put(ANN, agent({ id: 'p1', paused: true }));
  const before = structuredClone(store.list(ANN));
  undoMovePause(store, ANN, pauseForMove(store, ANN, NOW));
  const sorted = (xs: HiredAgent[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sorted(store.list(ANN)), sorted(before));
});

test('the runner sends nothing for an agent paused by a move, and its status says why', async () => {
  const store = openStore();
  store.put(ANN, agent());
  pauseForMove(store, ANN, NOW);
  const sent: unknown[] = [];
  const deps: Deps = {
    status: async () => ({ configured: true, holdings: [] }),
    signal: async () => ({ kind: 'position', live: true }),
    trade: async (_o, req) => { sent.push(req); return { ok: false, reason: 'should not be asked' }; },
    stop: async () => ({ ok: false, reason: 'not due' }),
  };
  const state = newRunnerState(300_000, NOW);
  await tick(store, deps, NOW + 5, state);
  assert.equal(sent.length, 0);
  assert.deepEqual(state.agents.get('a1'), { at: NOW + 5, k: 'paused', why: 'moved' });
  // an agent its owner paused has no reason attached
  store.put(ANN, agent({ id: 'p1', paused: true }));
  await tick(store, deps, NOW + 6, state);
  assert.deepEqual(state.agents.get('p1'), { at: NOW + 6, k: 'paused' });
});

/* ---------- the API ---------- */

async function serve(env: Record<string, string> = {}, store = openStore()) {
  const api = createApi({ MOA_SESSION_SECRET: 'secret', MOA_DATA_DIR: mkdtempSync(join(tmpdir(), 'moa-move-')), ...env }, { store });
  const server = createServer((req, res) => void api.handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = (who: string) => ({ authorization: `Bearer ${issue('secret', who as Address, Date.now() + 60_000)}` });
  const post = (path: string, body: unknown, who?: string, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? auth(who) : {}), ...headers }, body: JSON.stringify(body) });
  const get = async (path: string, who?: string) => (await fetch(`${url}${path}`, { headers: who ? auth(who) : {} })).json() as Promise<Record<string, unknown>>;
  return { url, post, get, store, close: () => server.close() };
}
const liveEnv = (rpcUrl: string) => ({ MOA_RPC_URL: rpcUrl, MOA_FACTORY_ADDRESS: F3, MOA_LEGACY_FACTORY_ADDRESSES: F2, MOA_AGENT_PRIVATE_KEY: AGENT_KEY });
const spec = () => ({ id: 'm1', name: 'ETH trend', market: 'ETHUSDT-PERPETUAL', ...fromTemplate('trend200')!, createdAt: 1 });

test('a demo server: no move, no creator fee on a new share, and upgrade is refused', async () => {
  const s = await serve();
  try {
    assert.equal((await s.post('/api/vault/upgrade', {})).status, 401, 'a login first');
    assert.equal((await s.post('/api/vault/upgrade', {}, ANN)).status, 503, 'this server makes no vaults');
    const v = await s.get('/api/vault', ANN);
    assert.deepEqual([v.configured, v.upgrade, v.moved, v.old, v.creatorFees], [false, { available: false }, false, undefined, false]);
    assert.deepEqual(await s.get('/api/terms'), { platformFeeBps: 0, creatorFees: false });
    const fee = await s.post('/api/shared', { spec: spec(), feeBps: 50, nick: 'Ann' }, ANN);
    assert.equal(fee.status, 400);
    assert.equal(((await fee.json()) as { why: string }).why, 'fee', 'a fee no vault could pay is refused, not stored');
    assert.equal((await s.post('/api/shared', { spec: spec(), feeBps: 0, nick: 'Ann' }, ANN)).status, 200);
  } finally { s.close(); }
});

test('GET /api/vault tells the app where the wallet stands; POST /api/vault/upgrade is protected and changes nothing twice', async () => {
  const w = world();
  const c = await chain(w);
  const store = openStore();
  store.put(ANN, agent({ log: [{ at: 1, k: 'hired', to: { perBuyUsd: 10, budgetUsd: 100 } }] }));
  const s = await serve(liveEnv(c.rpcUrl), store);
  try {
    const v = await s.get('/api/vault', ANN);
    assert.deepEqual([v.configured, v.vault, v.version, v.upgrade, v.moved, v.old, v.creatorFees, v.signedIn], [true, OLD, 2, { available: true, to: 3 }, false, undefined, true, true]);
    assert.deepEqual(((await s.get('/api/vault')) as { upgrade: unknown }).upgrade, { available: false }, 'logged out: nothing about anyone\'s vault');
    assert.equal((await s.get('/api/terms')).creatorFees, true);
    assert.equal((await s.post('/api/shared', { spec: spec(), feeBps: 50, nick: 'Ann' }, ANN)).status, 200, 'this server makes version-3 vaults: a fee may be asked');

    assert.equal((await s.post('/api/vault/upgrade', {})).status, 401);
    assert.equal((await s.post('/api/vault/upgrade', {}, ANN, { origin: 'https://elsewhere.example' })).status, 403);
    assert.equal((await s.post('/api/vault/upgrade', {}, ANN, { 'content-type': 'text/plain' })).status, 415);
    assert.equal(store.list(ANN)[0].paused, false, 'a refused request pauses nobody');

    // the vault cannot be made (the chain refuses): the answer says so and the agent is back at work, as it was
    w.createReverts = true;
    const before = structuredClone(store.list(ANN));
    const failed = await s.post('/api/vault/upgrade', {}, ANN);
    assert.equal(failed.status, 409);
    assert.deepEqual(((await failed.json()) as { ok: boolean; why: string; paused: number }).paused, 0);
    assert.deepEqual(store.list(ANN), before);

    // a wallet with nothing to move from
    const nothing = await s.post('/api/vault/upgrade', {}, BOB);
    assert.equal(nothing.status, 409);
    assert.equal(((await nothing.json()) as { why: string }).why, 'nothing');

    // the wallet has its new vault already: the same answer, nobody paused, as often as it is asked
    moved(w);
    for (let i = 0; i < 2; i++) {
      const again = await s.post('/api/vault/upgrade', {}, ANN);
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { ok: true, vault: NEW, made: false, from: OLD, paused: 0 });
    }
    assert.deepEqual(store.list(ANN), before);
    const after = await s.get('/api/vault', ANN) as { vault: string; version: number; moved: boolean; old: { vault: string; usdtBalance: string; version: number } };
    assert.deepEqual([after.vault, after.version, after.moved, after.old.vault, after.old.version, after.old.usdtBalance], [NEW, 3, true, OLD, 2, '9']);
  } finally { s.close(); c.close(); }
});

test('/api/auto/status carries the reason an agent rests, and resuming it clears the reason', async () => {
  const store = openStore();
  store.put(ANN, agent());
  store.put(ANN, agent({ id: 'p1', paused: true }));
  pauseForMove(store, ANN, NOW);
  const w = world();
  moved(w);
  const c = await chain(w);
  const s = await serve(liveEnv(c.rpcUrl), store);
  try {
    const st = await s.get('/api/auto/status', ANN) as { agents: { id: string; paused: boolean; why?: string }[] };
    assert.deepEqual(st.agents.map((a) => [a.id, a.paused, a.why]).sort(), [['a1', true, 'moved'], ['p1', true, undefined]]);
    const resumed = await s.post('/api/auto', { agent: { ...store.list(ANN).find((a) => a.id === 'a1'), paused: false } }, ANN);
    assert.equal(resumed.status, 200);
    const a1 = store.list(ANN).find((a) => a.id === 'a1')!;
    assert.ok(!a1.paused && a1.pausedWhy === undefined);
    const st2 = await s.get('/api/auto/status', ANN) as { agents: { id: string; paused: boolean; why?: string }[] };
    assert.equal(st2.agents.find((a) => a.id === 'a1')?.why, undefined);
  } finally { s.close(); c.close(); }
});
