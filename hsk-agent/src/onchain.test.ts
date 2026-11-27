import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyFlows, dayAgo, flowOf, onchainForModel, sideOf, viewOf, type FlowSwap } from './onchain.ts';

const DAY = 86_400_000, NOW = Date.UTC(2026, 5, 10, 12);
const sw = (h: number, side: 'buy' | 'sell', usdt: number, i = 0): FlowSwap => ({ block: 1000 + h * 1800 + i, time: NOW - h * 3_600_000, side, usdt, price: 0.08, tx: `0x${h}${i}` });

test('flows add up buys and sells in USDT inside the window, with the largest swap', () => {
  const xs = [sw(1, 'buy', 300), sw(2, 'sell', 100), sw(30, 'buy', 5000)];
  const f = flowOf(xs, NOW - DAY, NOW);
  assert.deepEqual([f.buy, f.sell, f.net, f.count], [300, 100, 200, 2]);
  assert.equal(f.largest?.usdt, 300);
  assert.equal(flowOf(xs, NOW - 7 * DAY, NOW).buy, 5300);
});

test('which side leans: 20% of the volume net, and too little trading is "quiet"', () => {
  assert.equal(sideOf({ buy: 600, sell: 400, net: 200 }), 'buyers');
  assert.equal(sideOf({ buy: 400, sell: 600, net: -200 }), 'sellers');
  assert.equal(sideOf({ buy: 550, sell: 450, net: 100 }), 'even');
  assert.equal(sideOf({ buy: 120, sell: 10, net: 110 }), 'quiet');
});

test('days are listed only from the first moment read, and liquidity a day ago needs 20 hours of records', () => {
  const since = NOW - 2.5 * DAY;
  const days = dailyFlows([sw(1, 'buy', 50), sw(26, 'sell', 70)], since, NOW);
  assert.equal(days.length, 3);   // UTC days from the one the read began in (8 June), through today (10 June)
  assert.equal(days.reduce((a, d) => a + d.count, 0), 2);
  assert.equal(dayAgo([{ t: NOW - 3_600_000, usd: 9 }], NOW), undefined);
  assert.equal(dayAgo([{ t: NOW - 26 * 3_600_000, usd: 7 }, { t: NOW - 23.5 * 3_600_000, usd: 8 }, { t: NOW, usd: 9 }], NOW), 8);
});

test('the view and what Moa sees from it', () => {
  const v = viewOf('HSK', [sw(1, 'buy', 900), sw(3, 'sell', 100)], NOW - 30 * DAY, [{ t: NOW - DAY, usd: 20_000 }, { t: NOW, usd: 18_000 }], NOW);
  assert.equal(v.side, 'buyers');
  assert.deepEqual(v.liquidity, { now: 18_000, dayAgo: 20_000 });
  const m = onchainForModel(v) as { last24h: { netUsd: number; leaning: string } };
  assert.equal(m.last24h.netUsd, 800);
  assert.equal(m.last24h.leaning, 'buyers');
  assert.match(JSON.stringify(onchainForModel(null)), /not finished/);
});
