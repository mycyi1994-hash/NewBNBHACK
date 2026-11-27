import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLp, reachOf, widthFor } from './lpTalk.ts';

test('amounts: a bare number or a money unit is USDT, a coin unit is the coin', () => {
  assert.deepEqual(parseLp('500'), { usdt: 500 });
  assert.deepEqual(parseLp('1,000 USDT'), { usdt: 1000 });
  assert.deepEqual(parseLp('$250 넣을게'), { usdt: 250 });
  assert.deepEqual(parseLp('300달러'), { usdt: 300 });
  assert.deepEqual(parseLp('0.002 btc도 넣어줘'), { coin: 0.002 });
  assert.deepEqual(parseLp('이더 0.1'), null, 'the unit must follow the number');
  assert.deepEqual(parseLp('0.1 이더'), { coin: 0.1 });
});

test('width: percent, or words', () => {
  const six = parseLp('±6%')!;
  assert.ok(Math.abs(reachOf({ step: six.step!, perSide: six.perSide! }) - 6) < 1, JSON.stringify(six));
  assert.deepEqual(parseLp('넓게 해줘'), widthFor(12));
  assert.deepEqual(parseLp('좁게'), widthFor(3));
  assert.equal(parseLp('10% 범위로 500 USDT')!.usdt, 500, 'the percent is not taken for the amount');
});

test('shape and side', () => {
  assert.equal(parseLp('현재가 근처에 몰아줘')?.shape, 'curve');
  assert.equal(parseLp('고르게')?.shape, 'spot');
  assert.equal(parseLp('양 끝에 많이')?.shape, 'bidask');
  assert.equal(parseLp('사는 쪽만 할래')?.coin, 0);
  assert.equal(parseLp('파는 쪽만')?.usdt, 0);
  assert.equal(parseLp('이게 무슨 뜻이야?'), null);
});

test('widths reach about what was asked', () => {
  for (const pct of [3, 6, 12, 24]) {
    const w = widthFor(pct);
    assert.ok(Math.abs(reachOf(w) - pct) / pct < 0.35, `${pct}% -> ${reachOf(w).toFixed(1)}%`);
  }
});

test('one side at a time: each side reaches its own distance with one shared step width', async () => {
  const { sidesFor, countFor } = await import('./lpTalk.ts');
  const w = sidesFor(5, 15);
  assert.equal(w.step % 60, 0);
  assert.ok(w.perSideUp! > w.perSide, JSON.stringify(w));
  const reach = (n: number, side: 'down' | 'up') => (side === 'down' ? (1 - Math.pow(1.0001, -w.step * (n + 0.5))) : (Math.pow(1.0001, w.step * (n + 0.5)) - 1)) * 100;
  assert.ok(Math.abs(reach(w.perSide, 'down') - 5) < 1.5, String(reach(w.perSide, 'down')));
  assert.ok(Math.abs(reach(w.perSideUp!, 'up') - 15) < 2, String(reach(w.perSideUp!, 'up')));
  assert.equal(countFor(80, 60, 'down'), 20, 'capped at 20 a side');
  assert.deepEqual(widthFor(8).perSideUp, widthFor(8).perSide);
});
