import assert from 'node:assert/strict';
import test from 'node:test';
import { contributionCents, demoReducer, initialState, progress, remaining } from './model.ts';

test('a sample purchase cannot execute below the threshold', () => {
  assert.equal(demoReducer(initialState, { type: 'purchase', expectedReceiptCount: 1 }), initialState);
});

test('a completed interest cycle conserves every cent and carries the remainder', () => {
  const ready = demoReducer(initialState, { type: 'accrue' });
  const result = demoReducer(ready, { type: 'purchase', expectedReceiptCount: 1 });
  const receipt = result.receipts[0];
  assert.equal(receipt.sourceCents, receipt.investedCents + receipt.carriedCents);
  assert.equal(result.availableCents, 3);
  assert.equal(result.carriedCents, 3);
  assert.equal(result.receipts.length, 2);
  assert.equal(demoReducer(result, { type: 'purchase', expectedReceiptCount: 1 }), result);
});

test('changing the next asset does not rewrite existing receipts', () => {
  const result = demoReducer(initialState, { type: 'asset', ticker: 'MSFT' });
  assert.equal(result.ticker, 'MSFT');
  assert.equal(result.receipts[0].ticker, 'NVDA');
});

test('a contribution purchase does not consume earned interest', () => {
  const contribution = demoReducer(initialState, { type: 'funding', funding: 'contribution' });
  const result = demoReducer(contribution, { type: 'purchase', contribution: 500, expectedReceiptCount: 1 });
  assert.equal(result.availableCents, 18);
  assert.equal(result.receipts[0].investedCents, 500);
  assert.equal(result.receipts[0].funding, 'contribution');
});

test('contribution amounts reject malformed, negative and out-of-range inputs', () => {
  for (const input of ['', '-5', '1e3', 'NaN', '0.001', '0.24', '1000.01', '5usd']) {
    assert.equal(contributionCents(input), null, input);
  }
  assert.equal(contributionCents('0.25'), 25);
  assert.equal(contributionCents('5.01'), 501);
});

test('progress and remaining amounts remain bounded at and above the threshold', () => {
  assert.equal(progress(18), 72);
  assert.equal(progress(28), 100);
  assert.equal(remaining(28), 0);
});
