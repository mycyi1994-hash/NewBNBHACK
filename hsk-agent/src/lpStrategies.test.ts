import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LP_STRATEGIES, replay, strategyPlan, type Candle } from './lpStrategies.ts';

const flat = (p: number, n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ time: i * 3600, open: p, high: p, low: p, close: p }));
const line = (ps: number[]): Candle[] => ps.slice(1).map((p, i) => ({ time: i * 3600, open: ps[i], high: Math.max(ps[i], p), low: Math.min(ps[i], p), close: p }));
const buy = strategyPlan(LP_STRATEGIES.find((s) => s.id === 'slowBuy')!);
const both = strategyPlan(LP_STRATEGIES.find((s) => s.id === 'wideGrid')!);

test('every strategy fits the pool: steps a multiple of 60, 3 to 20 a side', () => {
  for (const s of LP_STRATEGIES) {
    const p = strategyPlan(s);
    assert.equal(p.step % 60, 0, s.id);
    assert.ok(p.perSide >= 3 && p.perSide <= 20, s.id);
  }
});

test('a flat price changes nothing and earns nothing', () => {
  const r = replay(buy, flat(60000, 50))!;
  assert.equal(r.feeValue, 0);
  assert.equal(r.buys + r.sells, 0);
  assert.ok(Math.abs(r.endValue - 1000) < 1e-6);
  assert.ok(Math.abs(r.startValue - 1000) < 1e-6);
});

test('falling through every buy block turns all USDT into the coin and earns 0.3% of it', () => {
  const r = replay(buy, line([60000, 55000, 50000]))!;
  assert.equal(r.buys, buy.perSide);
  assert.ok(r.endUsdt < 1e-6);
  assert.ok(r.endCoin > 1000 / 60000, 'bought on the way down, so more coin than at the start price');
  assert.ok(Math.abs(r.feeValue / (r.endCoin * 50000) - 0.003) < 1e-9);
});

test('down and back up returns the USDT with fees on top', () => {
  const r = replay(buy, line([60000, 50000, 60000]))!;
  assert.equal(r.buys, buy.perSide);
  assert.equal(r.sells, buy.perSide);
  assert.ok(r.endCoin < 1e-12);
  assert.ok(Math.abs(r.endUsdt - 1000) < 1e-6, 'each block sells back in the same price band it bought in');
  assert.ok(Math.abs(r.endValue - 1000 - r.feeValue) < 1e-6);
  assert.ok(r.feeValue > 0);
  assert.ok(r.endValue > r.holdValue);
});

test('both ways: the hold value moves with the coin half only', () => {
  const r = replay(both, line([60000, 63000, 66000]))!;
  assert.ok(Math.abs(r.holdValue - (500 + (500 / 60000) * 66000)) < 1e-6);
  assert.ok(r.sells > 0 && r.buys === 0);
  assert.ok(r.endValue < r.holdValue, 'selling on the way up gives up some of the rise');
});
