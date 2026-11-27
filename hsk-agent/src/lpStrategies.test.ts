import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LP_STRATEGIES, strategyPlan } from './lpStrategies.ts';

test('every strategy fits the pool: steps a multiple of 60, 3 to 20 a side, the same count on both sides', () => {
  for (const s of LP_STRATEGIES) {
    const p = strategyPlan(s);
    assert.equal(p.step % 60, 0, s.id);
    assert.ok(p.perSide >= 3 && p.perSide <= 20, s.id);
    assert.equal(p.perSideUp, p.perSide, s.id);
    assert.equal(p.goal, s.goal);
  }
});

test('ids are unique and every goal has at least one strategy', () => {
  assert.equal(new Set(LP_STRATEGIES.map((s) => s.id)).size, LP_STRATEGIES.length);
  for (const g of ['buy', 'sell', 'both']) assert.ok(LP_STRATEGIES.some((s) => s.goal === g), g);
});
