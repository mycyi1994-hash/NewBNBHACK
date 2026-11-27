import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, type HiredAgent } from './runner.ts';
import { AGENT_COLORS, agentRows, coinSlices, totalPnl } from './portfolio.ts';

const NOW = 1_800_000_000_000;
const agent = (p: Partial<HiredAgent> = {}): HiredAgent => ({
  id: 'h1', createdAt: NOW - DAY, asset: 'ETH', perBuyUsd: 10, budgetUsd: 100, mode: 'ask', paused: false, fired: [], fills: [], log: [],
  source: { type: 'market', agentId: 'daily-ETHUSDT', kind: 'collect', rule: 'daily', base: 'ETH' }, ...p,
});
const buy = (usd: number, qty: number) => ({ at: NOW - 1000, side: 'buy' as const, usd, qty });
const prices = { ETH: 2000, BTC: 50_000 } as Record<string, number>;
const priceOf = (a: string) => prices[a];

test('an agent is worth its money plus its profit or loss; shares add up to one', () => {
  const a = agent({ fills: [buy(20, 0.011)] });                       // 0.011 ETH now $22: +$2
  const b = agent({ id: 'h2', createdAt: NOW - 2 * DAY, asset: 'BTC', budgetUsd: 50, fills: [buy(10, 0.0002)] }); // now $10: 0
  const rows = agentRows([a, b], priceOf, NOW);
  assert.equal(rows[0].value, 102);
  assert.equal(rows[1].value, 50);
  assert.ok(Math.abs(rows[0].share + rows[1].share - 1) < 1e-9);
  assert.ok(Math.abs(rows[0].pnlPct! - 0.1) < 1e-9);
  // colours follow hire order, not position in the list: the older agent gets the first colour
  assert.equal(rows[1].color, AGENT_COLORS[0]);
  assert.equal(rows[0].color, AGENT_COLORS[1]);
  const t = totalPnl(rows)!;
  assert.ok(Math.abs(t.usd - 2) < 1e-9);
});

test('no fills: no profit line, the whole budget is its value; paused agents are not running', () => {
  const rows = agentRows([agent({ paused: true })], priceOf, NOW);
  assert.equal(rows[0].pnl, undefined);
  assert.equal(rows[0].value, 100);
  assert.equal(rows[0].running, false);
  assert.equal(totalPnl(rows), undefined);
});

test('coins without a price are counted at cost and say so', () => {
  const rows = agentRows([agent({ asset: 'HSK', fills: [buy(5, 10)] })], priceOf, NOW);
  assert.equal(rows[0].atCost, true);
  assert.equal(rows[0].value, 100);
});

test('by coin: the vault when connected, otherwise the agents\' books', () => {
  const v = coinSlices({ configured: true, usdtBalance: '30', holdings: [{ symbol: 'WETH', address: '', decimals: 18, amount: '0.01', valueUsdt: '20' }, { symbol: 'WBTC', address: '', decimals: 8, amount: '0', valueUsdt: '0' }] }, [], priceOf);
  assert.equal(v.source, 'vault');
  assert.deepEqual(v.slices.map((s) => [s.key, s.value]), [['USDT', 30], ['ETH', 20]]);
  const b = coinSlices(null, [agent({ fills: [buy(20, 0.011)] })], priceOf);
  assert.equal(b.source, 'books');
  assert.deepEqual(b.slices.map((s) => [s.key, Math.round(s.value)]), [['USDT', 80], ['ETH', 22]]);
  assert.deepEqual(coinSlices({ configured: true, usdtBalance: '0', holdings: [] }, [], priceOf).slices, []);
});
