import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyImpact, poolDepth, type PoolState } from './depth.ts';
import { briefOf, liqMap, wallScale, walls, type HeatColumn, type Liq } from './nano.ts';

// A full-range pool holding 40,000 USDT and the same value of a coin at price 4 (raw units: USDT has 6 decimals).
// For such a pool L = sqrt(x*y), and the USDT side is L*sqrtPrice.
const sqrtPrice = 2, usdtRaw = 40_000e6;
const flat: PoolState = { sqrtPrice, tick: 13_863, liquidity: usdtRaw / sqrtPrice, ticks: [] };

test('a full-range pool: moving the price 1% takes about half a percent of its USDT', () => {
  const d = poolDepth(flat);
  const up1 = d.bands.find((b) => b.pct === 1)!, down1 = d.bands.find((b) => b.pct === -1)!;
  // sqrt(1.01) - 1 = 0.4988%, plus the 0.3% fee on the way in
  assert.ok(Math.abs(up1.usdt - (40_000 * (Math.sqrt(1.01) - 1)) / 0.997) < 0.01, String(up1.usdt));
  assert.ok(Math.abs(down1.usdt - 40_000 * (1 - Math.sqrt(0.99))) < 0.01, String(down1.usdt));
  assert.deepEqual(d.bands.map((b) => b.pct), [-5, -2, -1, 1, 2, 5]);
  // further costs more
  assert.ok(d.bands[5].usdt > d.bands[4].usdt && d.bands[4].usdt > d.bands[3].usdt);
});

test('a buy the size of the +1% band moves the price 1%', () => {
  const up1 = poolDepth(flat).bands.find((b) => b.pct === 1)!;
  assert.ok(Math.abs(buyImpact(flat, up1.usdt) - 0.01) < 1e-9);
  assert.ok(buyImpact(flat, 10) < buyImpact(flat, 100));
});

test('liquidity added just above the price makes that stretch deeper, and only that stretch', () => {
  // ten times the liquidity between +0.5% and +1.5% (ticks are 0.01% apart)
  const more: PoolState = { ...flat, ticks: [{ tick: flat.tick + 50, net: flat.liquidity * 9 }, { tick: flat.tick + 150, net: -flat.liquidity * 9 }] };
  const a = poolDepth(flat), b = poolDepth(more);
  const at = (d: typeof a, pct: number) => d.bands.find((x) => x.pct === pct)!.usdt;
  assert.ok(at(b, 1) > at(a, 1) * 4, 'the +1% move crosses the thick stretch');
  assert.equal(at(b, -1), at(a, -1), 'below the price nothing changed');
  assert.ok(buyImpact(more, 500) < buyImpact(flat, 500));
});

test('a pool with no liquidity above the price cannot be bought from', () => {
  const edge: PoolState = { ...flat, ticks: [{ tick: flat.tick + 10, net: -flat.liquidity }] };
  assert.equal(buyImpact(edge, 1_000_000), Infinity);
});

/* ---------- the order-book summary ---------- */

function book(): HeatColumn {
  // price 100, bins of 0.1 from 50
  const bins = new Float32Array(1000).fill(10);
  const at = (price: number) => Math.round((price - 50) / 0.1);
  bins[at(99)] = 900; bins[at(98.9)] = 400;      // one buy wall, two bins wide
  bins[at(96)] = 500;
  bins[at(101.5)] = 700;
  bins[at(100)] = 5000;                           // the bin the price is in: both sides, belongs to neither
  bins[at(80)] = 99_999;                          // far away: out of reach
  return { t: 1_000_000, mid: 100.04, lo: 50, step: 0.1, bins };
}

test('walls: the thickest stretches on each side, nearest first, without the bin the price is in', () => {
  const c = book();
  const buy = walls(c, 'buy'), sell = walls(c, 'sell');
  assert.ok(Math.abs(buy[0].price - 99) < 0.11 && buy[0].usd >= 1300, JSON.stringify(buy));
  assert.ok(buy.every((w) => w.awayPct < 0 && w.awayPct > -8.1) && sell.every((w) => w.awayPct > 0));
  assert.ok(Math.abs(sell.find((w) => w.usd >= 700)!.price - 101.5) < 0.11);
  assert.ok(![...buy, ...sell].some((w) => w.usd >= 5000), 'the price bin and the far wall are left out');
});

test('the wall scale: the 60th and 99.5th percentile of that moment, cached, the same at any zoom', () => {
  const c = book();
  const [floor, ceil] = wallScale(c);
  // nearly every bin holds 10, so a bin must hold more than that to show
  assert.equal(floor, 10);
  assert.ok(ceil >= floor * 2);
  assert.equal(wallScale(c), wallScale(c), 'worked out once per moment');
  assert.deepEqual(wallScale({ ...book(), bins: new Float32Array(1000) }), [0, 1]);
});

test('the liquidation map: longs land under the entry price, shorts over it, by leverage', () => {
  // everything entered at 100; bins of 1 from 40 to 160
  const m = liqMap([{ high: 100, low: 100, close: 100, volume: 5 }], 1_000_000, 40, 160, 120)!;
  const at = (price: number) => Math.floor((price - 40) / 1);
  // 10x: liquidated 10% away, less the 0.4% maintenance margin
  assert.ok(m.longs[at(100 * (1 - 0.1 + 0.004))] > 0 && m.shorts[at(100 * (1 + 0.1 - 0.004))] > 0);
  // 2x sits 50% away, 125x within 1%; nothing of either side lands on the wrong side of the entry
  assert.ok(m.longs[at(50.4)] > 0 && m.longs[at(99.6)] > 0 && m.shorts[at(100.4)] > 0);
  const sum = (a: Float64Array) => a.reduce((s, x) => s + x, 0);
  assert.equal(sum(m.longs.slice(at(100))), 0);
  assert.equal(sum(m.shorts.slice(0, at(100))), 0);
  // nothing is lost inside the range: both sides add up to the open interest, half each
  assert.ok(Math.abs(sum(m.longs) - 500_000) < 1e-6 && Math.abs(sum(m.shorts) - 500_000) < 1e-6);
  // a 70/30 long book puts 70% under the price
  const tilted = liqMap([{ high: 100, low: 100, close: 100, volume: 5 }], 1_000_000, 40, 160, 120, 0.7)!;
  assert.ok(Math.abs(sum(tilted.longs) - 700_000) < 1e-6);
  assert.equal(liqMap([], 1_000_000, 40, 160, 120), null);
  assert.equal(liqMap([{ high: 100, low: 100, close: 100, volume: 5 }], 0, 40, 160, 120), null);
});

test('liquidations: sums by side, and the biggest single order of the last hour only', () => {
  const now = 2_000_000;
  const liqs: Liq[] = [
    { t: now - 600, price: 99, usd: 5_000, long: true, sum: false },
    { t: now - 1200, price: 101, usd: 2_000, long: false, sum: false },
    { t: now - 7200, price: 98, usd: 900_000, long: true, sum: true },     // a quarter-hour total, not one order
    { t: now - 200_000, price: 90, usd: 9_999_999, long: true, sum: true }, // older than a day
  ];
  const b = briefOf('BTC', book(), liqs, now).liquidations!;
  assert.deepEqual(b.lastHour, { longs: 5_000, shorts: 2_000 });
  assert.deepEqual(b.last24h, { longs: 905_000, shorts: 2_000 });
  assert.deepEqual(b.biggestLastHour, { price: 99, usd: 5_000, side: 'long', minutesAgo: 10 });
  assert.equal(briefOf('BTC', book(), null, now).liquidations, undefined);
});
