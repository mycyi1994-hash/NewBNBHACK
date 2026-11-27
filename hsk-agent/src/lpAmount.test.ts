import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, coinQty, floorTo, maxUsd, money, pctText, priceText, shareOf } from './lpAmount.ts';

const P = 60463.37;   // WBTC on HSKSwap, 27 Nov 2026
const W = { usdt: 20, coin: 0.0000168 };   // the wallet in the owner's screenshot: 20 USDT and about $1.02 of WBTC

test('the most each goal can put in: both uses both tokens, not twice the smaller one', () => {
  assert.equal(maxUsd('buy', W, P), 20);
  assert.equal(maxUsd('sell', W, P), 1.01);
  assert.equal(maxUsd('both', W, P), 21.01);
});

test('both with too little of the coin: the coin side gets all it has, the rest stays in USDT, the total is kept', () => {
  const s = allocate('both', maxUsd('both', W, P) * 0.25, P, W, 8);
  assert.equal(s.short, 'coin');
  assert.ok(s.coin <= W.coin);
  assert.ok(Math.abs(s.coinUsd - W.coin * P) < 0.01);
  assert.ok(Math.abs(s.usdt + s.coinUsd - 5.25) < 0.011, `${s.usdt} + ${s.coinUsd}`);
  assert.ok(s.moved > 1);
});

test('both with enough of each: half and half, USDT to the cent, the coin to its decimals', () => {
  const s = allocate('both', 100, P, { usdt: 500, coin: 0.01 }, 8);
  assert.equal(s.short, undefined);
  assert.equal(s.usdt, 50);
  assert.equal(s.coin, floorTo(50 / P, 8));
  assert.ok(s.coinUsd <= 50 && s.coinUsd > 49.99);
});

test('both without a wallet (logged out): half and half', () => {
  const s = allocate('both', 0.5, P, null, 8);
  assert.equal(s.usdt, 0.25);
  assert.ok(s.coin > 0 && s.coin * P <= 0.25);
});

test('all of the coin never asks for more than the wallet holds', () => {
  const s = allocate('sell', maxUsd('sell', W, P) + 0.004, P, W, 8);
  assert.ok(s.coin <= W.coin);
  const e = allocate('sell', 3 * 2999.123456, 2999.123456, { usdt: 0, coin: 3 }, 18);
  assert.ok(e.coin <= 3);
});

test('buying more than the wallet holds is not shrunk silently (the studio shows the shortfall)', () => {
  assert.equal(allocate('buy', 50, P, W, 8).usdt, 50);
});

test('cents without float dust', () => {
  assert.equal(floorTo(0.29, 2), 0.29);
  assert.equal(floorTo(1.005, 2), 1);
  assert.equal(floorTo(20, 2), 20);
});

test('numbers as people read them', () => {
  assert.equal(money(0.5), '$0.50');
  assert.equal(money(0.004), '<$0.01');
  assert.equal(money(1234.5), '$1,234.50');
  assert.equal(money(25000.4), '$25,000');
  assert.equal(coinQty(0.000004215), '0.00000422');
  assert.equal(coinQty(0.0000168), '0.0000168');
  assert.equal(coinQty(0.00000001), '0.00000001');
  assert.equal(coinQty(1.23456), '1.2346');
  assert.ok(!/e/.test(coinQty(1e-9)));
  assert.equal(priceText(57117.4), '$57,117');
  assert.equal(priceText(0.012345), '$0.01235');
  assert.equal(pctText(0.034), '3.4%');
  assert.equal(pctText(0.0004), '<0.1%');
});

test('share of the pool: the part the plan adds', () => {
  assert.equal(shareOf(451, 451), 0);
  assert.ok(Math.abs(shareOf(451, 467)! - 16 / 467) < 1e-12);
  assert.equal(shareOf(0, 0), null);
});

test('all the way through: a range converts at the geometric mean of its edges, fees not counted', async () => {
  const { fullFill } = await import('./lpAmount.ts');
  const one = fullFill([{ lo: 90, hi: 110, amount: 100 }], 'buy')!;
  assert.ok(Math.abs(one.got - 100 / Math.sqrt(9900)) < 1e-12);
  assert.ok(Math.abs(one.avg - Math.sqrt(9900)) < 1e-9);
  const two = fullFill([{ lo: 90, hi: 100, amount: 50 }, { lo: 100, hi: 110, amount: 50 }], 'buy')!;
  assert.ok(two.avg > 90 && two.avg < 110 && two.spent === 100);
  const sell = fullFill([{ lo: 100, hi: 121, amount: 2 }], 'sell')!;
  assert.ok(Math.abs(sell.got - 2 * 110) < 1e-9 && Math.abs(sell.avg - 110) < 1e-9);
  assert.equal(fullFill([{ lo: 90, hi: 110, amount: 0 }], 'buy'), null);
});

test('holdings at a price: untouched above a buying step, all coin under it, part way inside; selling the other way', async () => {
  const { holdingsAt, fullFill } = await import('./lpAmount.ts');
  const buy = [{ lo: 90, hi: 110, amount: 100, side: 'buy' as const }];
  const above = holdingsAt(buy, 120);
  assert.ok(Math.abs(above.usdt - 100) < 1e-9 && Math.abs(above.coin) < 1e-12);
  const under = holdingsAt(buy, 80);
  assert.ok(Math.abs(under.usdt) < 1e-9 && Math.abs(under.coin - fullFill([{ lo: 90, hi: 110, amount: 100 }], 'buy')!.got) < 1e-12);
  assert.ok(Math.abs(under.worth - under.coin * 80) < 1e-9 && under.worth < 100);
  const mid = holdingsAt(buy, 100);
  assert.ok(mid.usdt > 0 && mid.usdt < 100 && mid.coin > 0);
  const sell = [{ lo: 100, hi: 121, amount: 2, side: 'sell' as const }];
  assert.ok(Math.abs(holdingsAt(sell, 90).coin - 2) < 1e-12);
  assert.ok(Math.abs(holdingsAt(sell, 130).usdt - 220) < 1e-9 && holdingsAt(sell, 130).coin < 1e-12);
});
