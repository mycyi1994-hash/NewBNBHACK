import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, parseVaultChange } from './chatOrders.ts';

test('a one-off order is read only when coin, side and amount are all clear', () => {
  assert.deepEqual(parseOrder('BTC 1달러 사줘'), { asset: 'BTC', side: 'buy', amount: 1 });
  assert.deepEqual(parseOrder('비트코인 5불어치 사 주세요'), { asset: 'BTC', side: 'buy', amount: 5 });
  assert.deepEqual(parseOrder('buy $2.5 of ETH'), { asset: 'ETH', side: 'buy', amount: 2.5 });
  assert.deepEqual(parseOrder('HSK 20개 팔아줘'), { asset: 'HSK', side: 'sell', amount: 20 });
  assert.deepEqual(parseOrder('이더 전부 팔아'), { asset: 'ETH', side: 'sell', amount: 'all' });
  assert.equal(parseOrder('비트코인 사줘'), undefined, 'no amount');
  assert.equal(parseOrder('1달러 사줘'), undefined, 'no coin');
  assert.equal(parseOrder('비트코인 어때?'), undefined);
  assert.equal(parseOrder('BTC 사줘 아니 팔아줘 1달러'), undefined, 'both sides');
});

test('a vault setting change is read from plain words', () => {
  assert.deepEqual(parseVaultChange('하루 한도 30달러로 해줘'), { kind: 'limits', perDay: 30 });
  assert.deepEqual(parseVaultChange('1회 한도 10불로'), { kind: 'limits', perTrade: 10 });
  assert.deepEqual(parseVaultChange('하루 한도 없애줘'), { kind: 'limits', perDay: null });
  assert.deepEqual(parseVaultChange('set the daily limit to $50'), { kind: 'limits', perDay: 50 });
  assert.deepEqual(parseVaultChange('손절 10%로'), { kind: 'stop', pct: 10 });
  assert.deepEqual(parseVaultChange('손절 꺼줘'), { kind: 'stop', pct: 0 });
  assert.equal(parseVaultChange('손절 200%로'), undefined);
  assert.deepEqual(parseVaultChange('볼트 잠가줘'), { kind: 'lock', on: true });
  assert.deepEqual(parseVaultChange('금고 멈춰줘'), { kind: 'lock', on: true });
  assert.deepEqual(parseVaultChange('잠금 풀어줘'), { kind: 'lock', on: false });
  assert.equal(parseVaultChange('비트코인 어때?'), undefined);
  assert.equal(parseVaultChange('BTC 1달러 사줘'), undefined);
});
