import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSpec, feeOn, feeText, linkedId, plainText, shareLink, validFee, FEE_CHOICES, MAX_FEE_BPS } from './share.ts';
import { fromTemplate } from './spec.ts';

const MARKETS = ['BTCUSDT-PERPETUAL', 'ETHUSDT-PERPETUAL', 'HSKUSDT'];
const good = () => ({ id: 'mine1', name: '  My ETH trend  ', market: 'ETHUSDT-PERPETUAL', ...fromTemplate('trend200')!, createdAt: 1, from: 'trend200' });

test('a clean rule comes back rebuilt, with the server id and time, its name trimmed', () => {
  const s = cleanSpec(good(), MARKETS, 'abc123', 99);
  assert.ok(s);
  assert.equal(s.id, 'abc123');
  assert.equal(s.createdAt, 99);
  assert.equal(s.name, 'My ETH trend');
  assert.equal(s.from, 'trend200');
  assert.deepEqual(s.buy, [{ a: { k: 'price' }, op: 'above', b: { k: 'sma', n: 200 } }]);
});

test('a rule that does not pass problems(), or carries anything unknown, is refused, not repaired', () => {
  const bad: unknown[] = [
    { ...good(), buy: [] },                                                   // nothing to buy on
    { ...good(), name: '   ' },                                               // no name
    { ...good(), market: 'SOLUSDT' },                                         // a coin no vault can trade
    { ...good(), buy: [{ a: { k: 'price' }, op: 'above', b: { k: 'sma', n: 5000 } }] },   // out of range
    { ...good(), buy: [{ a: { k: 'eval' }, op: 'above', b: { k: 'num', n: 1 } }] },       // unknown kind
    { ...good(), buy: [{ a: { k: 'price' }, op: 'xor', b: { k: 'sma', n: 20 } }] },       // unknown comparison
    { ...good(), buy: [{ a: { k: 'rsi', n: 14 }, op: 'above', b: { k: 'sma', n: 20 } }] }, // RSI against a price
    { ...good(), buy: [{ a: { k: 'price' }, op: 'above', b: { k: 'sma', n: Infinity } }] },
    { ...good(), interval: '5m' },
    { ...good(), buy: Array(4).fill({ a: { k: 'price' }, op: 'above', b: { k: 'sma', n: 20 } }) },
    null, 'trend', { ...good(), sell: 'x' },
  ];
  for (const x of bad) assert.equal(cleanSpec(x, MARKETS, 'id', 1), null, JSON.stringify(x));
});

test('extra fields never travel: only the rule is kept', () => {
  const s = cleanSpec({ ...good(), creator: '0xbad', code: 'alert(1)', buy: [{ a: { k: 'price', n: 7, x: 1 }, op: 'above', b: { k: 'sma', n: 200, y: 2 } }] }, MARKETS, 'id', 1)!;
  assert.deepEqual(Object.keys(s).sort(), ['buy', 'createdAt', 'from', 'id', 'market', 'name', 'sell']);
  assert.deepEqual(s.buy[0], { a: { k: 'price' }, op: 'above', b: { k: 'sma', n: 200 } });
});

test('names and nicknames lose control characters and are cut to length', () => {
  assert.equal(plainText('a\u0000b‮c\n', 10), 'abc');
  assert.equal(plainText('x'.repeat(60), 40).length, 40);
  assert.equal(plainText(42, 10), '');
});

test('fees: whole basis points from 0 to the contract cap of 1%', () => {
  assert.equal(MAX_FEE_BPS, 100);
  for (const f of FEE_CHOICES) assert.ok(validFee(f));
  for (const f of [-1, 101, 2.5, '50', NaN]) assert.equal(validFee(f), false);
  assert.equal(feeText(50), '0.5%');
  assert.equal(feeText(100), '1%');
  assert.equal(feeText(25), '0.25%');
  assert.equal(feeOn(10, 50), 0.05);
});

test('the link carries the id and is read back from the address', () => {
  const link = shareLink('https://moa.example/', 'a1b2c3d4');
  assert.equal(link, 'https://moa.example/?agent=a1b2c3d4');
  assert.equal(linkedId(new URL(link).search), 'a1b2c3d4');
  assert.equal(linkedId('?agent=../../x'), null);
  assert.equal(linkedId(''), null);
});
