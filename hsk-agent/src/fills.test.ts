import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSUMED_USD, EXCHANGE_FEE, HAIRCUT, POOL_FEE, exchangeModel, haircutModel, impact, measureBasis, poolModel, sellMove, sideCost } from './fills.ts';
import { buyImpact, type PoolState } from './depth.ts';

// A pool with even liquidity around tick 0 (price 1), like a V3 position from tick −20000 to +20000.
const pool = (liquidity: number): PoolState => ({ sqrtPrice: 1, tick: 0, liquidity, ticks: [{ tick: -20000, net: liquidity }, { tick: 20000, net: -liquidity }] });

test('one side of a trade: fee, the moving gap, and half the price move of the size traded', () => {
  const deep = pool(1e12), thin = pool(5e10);
  assert.ok(impact(thin, 1000, 'buy') > impact(deep, 1000, 'buy'), 'a thin pool costs more');
  assert.ok(impact(thin, 10_000, 'buy') > impact(thin, 1000, 'buy'), 'a bigger order costs more');
  assert.ok(Math.abs(impact(thin, 1000, 'buy') - buyImpact(thin, 1000) / 2) < 1e-15);
  assert.ok(sellMove(thin, 1000) > 0 && Math.abs(sellMove(thin, 1000) - buyImpact(thin, 1000)) < 0.01, 'selling moves it about as far down');
  const m = poolModel(thin, { median: -0.015, mad: 0.002, n: 12 });
  assert.equal(m.source, 'pool');
  assert.ok(Math.abs(sideCost(m, ASSUMED_USD, 'buy') - (POOL_FEE + 0.002 + impact(thin, ASSUMED_USD, 'buy'))) < 1e-15, 'the steady −1.5% gap itself is not a cost');
  assert.equal(sideCost(haircutModel(), 1000, 'sell'), POOL_FEE + HAIRCUT, 'no pool data: fee plus the stated haircut');
  assert.equal(sideCost(exchangeModel(), 1000, 'buy'), EXCHANGE_FEE, 'no pool: the exchange fee only');
  assert.equal(poolModel(thin, null).source, 'haircut', 'too few swaps to measure: never a better fill than the haircut');
});

test('the gap is measured swap by swap against the exchange hour it falls in', () => {
  const H = 3600;
  const candles = Array.from({ length: 48 }, (_, i) => ({ time: 1_700_000_000 + i * H, close: 100 + i }));
  const swaps = [3, 7, 12, 20, 33, 40].map((i, k) => ({ time: (candles[i].time + 600) * 1000, price: candles[i].close * (k % 2 ? 0.984 : 0.986) }));
  const g = measureBasis(swaps, candles)!;
  assert.equal(g.n, 6);
  assert.ok(Math.abs(g.median - -0.015) < 1e-9, 'median gap −1.5%');
  assert.ok(Math.abs(g.mad - 0.001) < 1e-9, 'it moves ±0.1% around it');
  assert.equal(measureBasis(swaps.slice(0, 4), candles), null, 'fewer than five swaps: not measured');
  assert.equal(measureBasis([{ time: (candles[47].time + 2 * H) * 1000, price: 1 }], candles), null, 'a swap outside the candles does not count');
});
