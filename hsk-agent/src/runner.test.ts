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
