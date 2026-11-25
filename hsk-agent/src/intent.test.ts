import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botName, describe, parseIntent, scheduleOf, type AccumulateStep } from './intent.ts';

test('daily buys with a duration and a stop-loss, in one sentence', () => {
  const p = parseIntent('Collect $10 of HSK every day for 2 weeks, sell half if it drops 15%');
  assert.deepEqual(p.missing, []);
  assert.equal(p.steps.length, 2);
  const a = p.steps[0] as AccumulateStep;
  assert.equal(a.kind, 'accumulate');
  assert.equal(a.asset, 'HSK');
  assert.equal(a.perBuyUsd, 10);
  assert.equal(a.every, 'day');
  assert.equal(a.durationDays, 14);
  assert.deepEqual(scheduleOf(a), { buys: 14, totalUsd: 140 });
  assert.deepEqual(p.steps[1], { kind: 'stopLoss', asset: 'HSK', dropPct: 15, sellFraction: 0.5 });
  assert.equal(botName(p), 'HSK Stacker');
});

test('goal-based accumulation with target, deadline, price cap and budget', () => {
  const p = parseIntent('Accumulate 5,000 HSK by Dec 31 under 0.08, budget $400');
  assert.deepEqual(p.missing, []);
  const a = p.steps[0] as AccumulateStep;
  assert.equal(a.targetQty, 5000);
  assert.equal(a.deadline, 'Dec 31');
  assert.equal(a.maxPrice, 0.08);
  assert.equal(a.budgetUsd, 400);
  assert.equal(a.perBuyUsd, undefined);
});

test('take profit and earn chained with then', () => {
  const p = parseIntent('Buy $25 of ETH every week for 2 months, take a third at +30%, then stake idle USDT');
  assert.equal(p.steps.length, 3);
  assert.deepEqual(p.steps[1], { kind: 'takeProfit', asset: 'ETH', risePct: 30, sellFraction: 1 / 3 });
  assert.deepEqual(p.steps[2], { kind: 'earn', what: 'idle USDT' });
  assert.deepEqual(scheduleOf(p.steps[0] as AccumulateStep), { buys: 9, totalUsd: 225 });
});

test('asks follow-up questions instead of guessing', () => {
  assert.match(parseIntent('Buy some HSK').missing[0], /How much/);
  assert.match(parseIntent('Collect 5000 HSK').missing[0], /By when/);
  assert.match(parseIntent('buy $10 every day').missing[0], /Which coin/);
  assert.match(parseIntent('Buy $10 of BTC daily').missing[0], /how long/);
  assert.match(parseIntent('hello there').missing[0], /Tell me a goal/);
});

test('stop-loss alone, with a percentage of the position', () => {
  const p = parseIntent('If BTC falls 20%, sell 40% of it');
  assert.deepEqual(p.steps, [{ kind: 'stopLoss', asset: 'BTC', dropPct: 20, sellFraction: 0.4 }]);
  assert.equal(describe(p.steps[0]), 'Sell 40% of BTC if it falls 20% below my average cost');
  assert.equal(botName(p), 'BTC Guard');
});
