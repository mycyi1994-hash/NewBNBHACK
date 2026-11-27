import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoBlock, signalTtl, tick, TICK_MS, type Deps } from './autoRunner.ts';
import { openStore } from './autoStore.ts';
import { book, type HiredAgent, type Signal } from '../src/runner.ts';

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const NOW = 1_800_000_000_000, DAY = 86_400_000;
const agent = (over: Partial<HiredAgent> = {}): HiredAgent => ({
  id: 'a1', createdAt: NOW - DAY, asset: 'ETH', perBuyUsd: 10, budgetUsd: 100, mode: 'auto', paused: false, fired: [], fills: [], log: [],
  source: { type: 'market', agentId: 'trend200:ETHUSDT-PERPETUAL', kind: 'position', rule: 'trend200', base: 'ETH' }, ...over,
});

/** A stand-in chain and market: fills every order at $2,000 per ETH and remembers what it was asked. */
function world(signal: Signal, vault: Partial<Awaited<ReturnType<Deps['status']>>> = {}) {
  const sent: { side: string; amount: number; note: string }[] = [];
  const stops: string[] = [];
  const state = { signal, fail: false, vault: { configured: true, maxTradeUsdt: '50', maxDailyUsdt: '100', holdings: [] as { symbol: string; amount: string; stopDue?: boolean }[], ...vault } };
  const deps: Deps = {
    status: async () => state.vault,
    signal: async () => state.signal,
    trade: async (_owner, req) => {
      sent.push(req);
      if (state.fail) return { ok: false, reason: 'DailyCapExceeded(110000000, 100000000)' };
      const eth = req.side === 'buy' ? req.amount / 2000 : req.amount;
      state.vault.holdings = [{ symbol: 'WETH', amount: String(req.side === 'buy' ? eth : 0) }];
      return { ok: true, txHash: '0xabc', explorerUrl: 'https://x/tx/0xabc', amountIn: String(req.amount), amountOut: String(req.side === 'buy' ? eth : eth * 2000), tokenIn: '', tokenOut: '', block: '1' };
    },
    stop: async (_owner, asset) => { stops.push(asset); state.vault.holdings = []; return { ok: true, txHash: '0xstop', explorerUrl: 'https://x/tx/0xstop', amountOut: '17' }; },
  };
  return { deps, sent, stops, state };
}

test('an agent on auto buys when its signal is on, once, with no one asked', async () => {
  const store = openStore();
  store.put(OWNER, agent());
  const w = world({ kind: 'position', live: true });
  await tick(store, w.deps, NOW);
  assert.equal(w.sent.length, 1);
  assert.deepEqual({ side: w.sent[0].side, amount: w.sent[0].amount }, { side: 'buy', amount: 10 });
  assert.match(w.sent[0].note, /standing order from the owner/);
  const h = store.list(OWNER)[0];
  assert.equal(h.fills.length, 1);
  assert.equal(h.pending, undefined);
  assert.equal(h.log.at(-1)?.k, 'filled');
  await tick(store, w.deps, NOW + 300_000);
  assert.equal(w.sent.length, 1, 'holding and the signal still on: nothing more to do');
});

test('it sells what it holds when the signal goes off, and never more than the vault has', async () => {
  const store = openStore();
  store.put(OWNER, agent());
  const w = world({ kind: 'position', live: true });
  await tick(store, w.deps, NOW);
  w.state.signal = { kind: 'position', live: false };
  w.state.vault.holdings = [{ symbol: 'WETH', amount: '0.003' }];   // the owner withdrew some
  await tick(store, w.deps, NOW + DAY);
  assert.equal(w.sent[1].side, 'sell');
  assert.equal(w.sent[1].amount, 0.003);
  assert.equal(store.list(OWNER)[0].fills.length, 2);
});

test('with a locked vault, a paused agent or no vault, nothing is sent', async () => {
  for (const [vault, over] of [[{ paused: true }, {}], [{}, { paused: true }], [{ configured: false }, {}]] as const) {
    const store = openStore();
    store.put(OWNER, agent(over));
    const w = world({ kind: 'position', live: true }, vault);
    await tick(store, w.deps, NOW);
    assert.equal(w.sent.length, 0, JSON.stringify([vault, over]));
  }
  assert.equal(autoBlock({ configured: false }), 'noVault');
  assert.equal(autoBlock({ configured: true }), undefined);
});

test('limits are the owner\'s choice: with none set on the vault, an agent on auto still works inside its own budget', async () => {
  const store = openStore();
  store.put(OWNER, agent({ budgetUsd: 15 }));
  const w = world({ kind: 'position', live: true }, { maxDailyUsdt: undefined, maxTradeUsdt: undefined });
  await tick(store, w.deps, NOW);
  assert.deepEqual(w.sent.map((x) => x.amount), [10]);
  // sold, signal on again: only what is left of its budget
  w.state.signal = { kind: 'position', live: false };
  await tick(store, w.deps, NOW + 300_000);
  w.state.signal = { kind: 'position', live: true };
  await tick(store, w.deps, NOW + 600_000);
  assert.deepEqual(w.sent.map((x) => [x.side, x.amount]).at(-1), ['buy', 5]);
});

test('an order the vault refuses is logged and not sent again every five minutes', async () => {
  const store = openStore();
  store.put(OWNER, agent());
  const w = world({ kind: 'position', live: true });
  w.state.fail = true;
  await tick(store, w.deps, NOW);
  await tick(store, w.deps, NOW + 300_000);
  await tick(store, w.deps, NOW + 600_000);
  assert.equal(w.sent.length, 1);
  const last = store.list(OWNER)[0].log.at(-1);
  assert.ok(last?.k === 'failed' && /DailyCapExceeded/.test(last.reason));
});

test('a collect agent buys once a day, by its multiplier, and skips a day the rule says to sit out', async () => {
  const store = openStore();
  store.put(OWNER, agent({ source: { type: 'market', agentId: 'smart:ETH', kind: 'collect', rule: 'smart', base: 'ETH' } }));
  const w = world({ kind: 'collect', mult: 2 });
  await tick(store, w.deps, NOW);
  await tick(store, w.deps, NOW + 3_600_000);
  assert.deepEqual(w.sent.map((x) => x.amount), [20]);
  w.state.signal = { kind: 'collect', mult: 0 };
  await tick(store, w.deps, NOW + DAY + 1000);
  assert.equal(w.sent.length, 1);
  assert.equal(store.list(OWNER)[0].log.at(-1)?.k, 'skipped');
});

test('a stop-loss that is due is carried out, and the agent on that coin gets the sale on its books', async () => {
  const store = openStore();
  store.put(OWNER, agent());
  const w = world({ kind: 'position', live: true });
  await tick(store, w.deps, NOW);
  w.state.vault.holdings = [{ symbol: 'WETH', amount: '0.005', stopDue: true }];
  await tick(store, w.deps, NOW + 300_000);
  assert.deepEqual(w.stops, ['ETH']);
  const h = store.list(OWNER)[0];
  assert.equal(book(h).qty, 0);
  assert.equal(h.fills.at(-1)?.usd, 17);
  assert.equal(h.fills.at(-1)?.txHash, '0xstop');
  // the signal is still on, but it does not buy straight back in
  await tick(store, w.deps, NOW + 600_000);
  assert.equal(w.sent.length, 1);
  // only after the signal has gone off and come on again
  w.state.signal = { kind: 'position', live: false };
  await tick(store, w.deps, NOW + 900_000);
  w.state.signal = { kind: 'position', live: true };
  await tick(store, w.deps, NOW + 1_200_000);
  assert.equal(w.sent.length, 2);
});

test('after a stop-loss, an agent that buys on a schedule is paused instead of buying again the next day', async () => {
  const store = openStore();
  store.put(OWNER, agent({ source: { type: 'market', agentId: 'smart:ETH', kind: 'collect', rule: 'smart', base: 'ETH' } }));
  const w = world({ kind: 'collect', mult: 1 });
  await tick(store, w.deps, NOW);
  w.state.vault.holdings = [{ symbol: 'WETH', amount: '0.005', stopDue: true }];
  await tick(store, w.deps, NOW + DAY + 1000);
  assert.equal(store.list(OWNER)[0].paused, true);
  assert.equal(w.sent.length, 1);
});

test('an owner with a vault and no auto agent still has stop-losses watched', async () => {
  const store = openStore();
  store.seen(OWNER);
  const w = world({ kind: 'position', live: false }, { holdings: [{ symbol: 'WBTC', amount: '0.001', stopDue: true }] });
  await tick(store, w.deps, NOW);
  assert.deepEqual(w.stops, ['BTC']);
});

test('the store survives a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'moa-')), 'auto.json');
  const a = openStore(file);
  a.put(OWNER, agent());
  a.put(OWNER, agent({ id: 'a2' }));
  a.remove(OWNER, 'a1');
  const b = openStore(file);
  assert.deepEqual(b.list(OWNER.toLowerCase()).map((x) => x.id), ['a2']);
  assert.deepEqual(b.owners(), [OWNER.toLowerCase()]);
});

test('a made agent on hourly candles is re-read within one pass of each candle closing; daily ones as before', () => {
  const spec = { id: 's', name: 'S', market: 'ETHUSDT-PERPETUAL', createdAt: 0, buy: [], sell: [] };
  assert.equal(signalTtl({}), 10 * 60_000, 'market agents: unchanged');
  assert.equal(signalTtl({ spec }), 10 * 60_000, 'a made agent saved before intervals: daily');
  assert.ok(signalTtl({ spec: { ...spec, interval: '1h' } }) <= TICK_MS, 'hourly: never older than one pass');
  assert.ok(signalTtl({ spec: { ...spec, interval: '4h' } }) <= TICK_MS);
});
