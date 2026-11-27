import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book, decide, pnl, statusOf, DAY, type HiredAgent } from './runner.ts';
import { parseIntent } from './intent.ts';

const NOW = 1_800_000_000_000;
const agent = (p: Partial<HiredAgent> = {}): HiredAgent => ({
  id: 'h1', createdAt: NOW - DAY, asset: 'ETH', perBuyUsd: 10, budgetUsd: 100, mode: 'ask', paused: false, fired: [], fills: [], log: [],
  source: { type: 'market', agentId: 'boll-ETHUSDT-PERPETUAL', kind: 'position', rule: 'boll', base: 'ETH' }, ...p,
});
const bought = (usd: number, qty: number) => ({ at: NOW - 1000, side: 'buy' as const, usd, qty });

test('position agent: buys when the signal turns on, sells everything when it turns off', () => {
  const d = decide(agent(), { kind: 'position', live: true }, NOW, { maxTradeUsd: 8 });
  assert.deepEqual(d, { type: 'order', order: { side: 'buy', usd: 8, why: { k: 'signalOn' } } }, 'capped by the vault per-trade limit');
  const holding = agent({ fills: [bought(10, 0.004)] });
  assert.deepEqual(decide(holding, { kind: 'position', live: true }, NOW), { type: 'idle', clearDeclined: false });
  assert.deepEqual(decide(holding, { kind: 'position', live: false }, NOW), { type: 'order', order: { side: 'sell', qty: 0.004, why: { k: 'signalOff' } } });
});

test('position agent: a declined buy is not asked again until the signal flips; a stale order is cancelled', () => {
  const declined = agent({ declined: 'buy' });
  assert.deepEqual(decide(declined, { kind: 'position', live: true }, NOW), { type: 'idle' });
  assert.deepEqual(decide(declined, { kind: 'position', live: false }, NOW), { type: 'idle', clearDeclined: true });
  const pending = agent({ pending: { id: 'o1', at: NOW, side: 'buy', usd: 10, why: { k: 'signalOn' } } });
  assert.deepEqual(decide(pending, { kind: 'position', live: false }, NOW), { type: 'cancel' });
  assert.deepEqual(decide(agent({ paused: true }), { kind: 'position', live: true }, NOW), { type: 'idle' });
});

test('collect agent: one buy a day sized by the rule, skips when the rule says 0, stops at the budget', () => {
  const h = agent({ source: { type: 'market', agentId: 'smart-ETH', kind: 'collect', rule: 'smart', base: 'ETH' } });
  assert.deepEqual(decide(h, { kind: 'collect', mult: 1.37 }, NOW), { type: 'order', order: { side: 'buy', usd: 13.7, why: { k: 'daily', mult: 1.37 } } });
  assert.deepEqual(decide({ ...h, lastRunAt: NOW - DAY / 2 }, { kind: 'collect', mult: 1 }, NOW), { type: 'idle' });
  assert.deepEqual(decide(h, { kind: 'collect', mult: 0 }, NOW), { type: 'skip', why: { k: 'belowMa' } });
  const nearlyDone = { ...h, fills: [bought(95, 0.03)] };
  assert.deepEqual(decide(nearlyDone, { kind: 'collect', mult: 2 }, NOW), { type: 'order', order: { side: 'buy', usd: 5, why: { k: 'daily', mult: 2 } } });
  assert.equal(statusOf({ ...h, fills: [bought(100, 0.03)] }, NOW), 'done');
});

test('custom plan: stop-loss below the average cost comes before the next buy; the price cap skips a buy', () => {
  const plan = parseIntent('Collect $10 of ETH every day for 2 weeks under 4000, sell half if it drops 15%');
  const h = agent({ source: { type: 'custom', goal: 'g', plan }, fills: [bought(20, 0.01)] });
  assert.equal(book(h).avg, 2000);
  assert.deepEqual(decide(h, { kind: 'custom', price: 1690 }, NOW), { type: 'order', order: { side: 'sell', qty: 0.005, why: { k: 'stop', pct: 15, key: 'stop:1' } } });
  assert.deepEqual(decide(h, { kind: 'custom', price: 1900 }, NOW), { type: 'order', order: { side: 'buy', usd: 10, why: { k: 'plan' } } });
  assert.deepEqual(decide(h, { kind: 'custom', price: 4100 }, NOW), { type: 'skip', why: { k: 'overMax', max: 4000 } });
});

test('book and profit: average cost survives a partial sell', () => {
  const h = agent({ fills: [bought(10, 0.005), bought(10, 0.005), { at: NOW, side: 'sell', usd: 12, qty: 0.005 }] });
  const b = book(h);
  assert.equal(b.qty, 0.005);
  assert.equal(b.spent, 20);
  assert.equal(b.proceeds, 12);
  assert.equal(b.avg, 2000);
  assert.equal(pnl(h, 2400), 0.005 * 2400 + 12 - 20);
  assert.equal(pnl(agent(), 2400), undefined, 'no number before the first fill');
});

/* ---------- weight agents: hold a share of the budget, rebalance on a band ---------- */

const w = (target: number, price = 100, band = 0.1) => ({ kind: 'weight' as const, target, band, price });
const weighted = (p: Partial<HiredAgent> = {}) => agent({ source: { type: 'market', agentId: 'volTarget-ETHUSDT-PERPETUAL', kind: 'position', rule: 'volTarget', base: 'ETH' }, perBuyUsd: 100, budgetUsd: 100, ...p });

test('weight agent: buys up to its target share of the budget, then waits inside the band', () => {
  assert.deepEqual(decide(weighted(), w(0.6), NOW), { type: 'order', order: { side: 'buy', usd: 60, why: { k: 'weight', pct: 60 } } }, '60% of a $100 budget');
  // 0.5 coin at $100 = $50 = 50% held: a 60% target is exactly 10 points away, so it tops up by the difference.
  assert.deepEqual(decide(weighted({ fills: [bought(50, 0.5)] }), w(0.6), NOW), { type: 'order', order: { side: 'buy', usd: 10, why: { k: 'weight', pct: 60 } } });
  // 0.55 coin = 55% held, target 60%: inside the band, nothing to do.
  assert.deepEqual(decide(weighted({ fills: [bought(55, 0.55)] }), w(0.6), NOW), { type: 'idle', clearDeclined: false });
  // The price moved: 0.55 coin at $80 is $44 = 44% held, 16 points under: buy $16 back to 60%.
  assert.deepEqual(decide(weighted({ fills: [bought(55, 0.55)] }), w(0.6, 80), NOW), { type: 'order', order: { side: 'buy', usd: 16, why: { k: 'weight', pct: 60 } } });
});

test('weight agent: sells the difference, all of it at a zero target, never more than it holds', () => {
  const d = decide(weighted({ fills: [bought(80, 0.8)] }), w(0.3), NOW);
  assert.equal(d.type, 'order');
  if (d.type === 'order') { assert.equal(d.order.side, 'sell'); assert.ok(Math.abs((d.order.qty ?? 0) - 0.5) < 1e-9, 'from 80% to 30%: sell half a coin'); assert.deepEqual(d.order.why, { k: 'weight', pct: 30 }); }
  assert.deepEqual(decide(weighted({ fills: [bought(80, 0.8)] }), w(0), NOW), { type: 'order', order: { side: 'sell', qty: 0.8, why: { k: 'weight', pct: 0 } } });
  assert.deepEqual(decide(weighted(), w(0), NOW), { type: 'idle', clearDeclined: false }, 'nothing held, nothing wanted');
});

test('weight agent: a buy never takes the cost of what it holds past the budget, nor past the vault per-trade limit', () => {
  // It paid $90 for coins now worth $40 (40%); the 100% target would need $60, but only $10 of budget is left at cost.
  assert.deepEqual(decide(weighted({ fills: [bought(90, 0.4)] }), w(1), NOW), { type: 'order', order: { side: 'buy', usd: 10, why: { k: 'weight', pct: 100 } } });
  assert.deepEqual(decide(weighted({ fills: [bought(100, 0.4)] }), w(1), NOW), { type: 'idle' }, 'budget used at cost: no buy');
  assert.deepEqual(decide(weighted(), w(1), NOW, { maxTradeUsd: 25 }), { type: 'order', order: { side: 'buy', usd: 25, why: { k: 'weight', pct: 100 } } });
  // Sold back: what it sold no longer counts against the budget, so it can buy again.
  const roundTrip = weighted({ fills: [bought(100, 1), { at: NOW - 500, side: 'sell', usd: 100, qty: 1 }] });
  assert.deepEqual(decide(roundTrip, w(0.5), NOW), { type: 'order', order: { side: 'buy', usd: 50, why: { k: 'weight', pct: 50 } } });
});

test('weight agent: asks once, keeps a declined side quiet until the target settles, cancels a stale ask', () => {
  const pending = weighted({ pending: { id: 'o1', at: NOW, side: 'buy', usd: 60, why: { k: 'weight', pct: 60 } } });
  assert.deepEqual(decide(pending, w(0.6), NOW), { type: 'idle' }, 'still waiting for the answer');
  assert.deepEqual(decide(pending, w(0), NOW), { type: 'cancel' }, 'the target fell back: the buy ask is stale');
  assert.deepEqual(decide(weighted({ declined: 'buy' }), w(0.6), NOW), { type: 'idle' });
  assert.deepEqual(decide(weighted({ declined: 'buy' }), w(0.05), NOW), { type: 'idle', clearDeclined: true });
  assert.deepEqual(decide(weighted({ paused: true }), w(0.6), NOW), { type: 'idle' });
});

test('the runner reads an agent the same way in the app and on the server', async () => {
  const { agentSignal, chainNote } = await import('./runner.ts');
  assert.deepEqual(agentSignal({ kind: 'position', live: true, mult: 0.4, target: 0.55, band: 0.15, price: 3000 }), { kind: 'weight', target: 0.55, band: 0.15, price: 3000 });
  assert.deepEqual(agentSignal({ kind: 'position', live: true, mult: 1, price: 3000 }), { kind: 'position', live: true });
  assert.deepEqual(agentSignal({ kind: 'collect', live: true, mult: 2, price: 3000 }), { kind: 'collect', mult: 2 });
  assert.match(chainNote('ETH volTarget', { k: 'weight', pct: 60 }, 'auto'), /rebalance to 60%/);
});
