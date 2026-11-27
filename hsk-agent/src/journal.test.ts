import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, stringToBytes } from 'viem';
import { canonical, journalHash, makeJournal, noteWithHash, verifyJournal, type JournalEntry } from './journal.ts';
import { chainNote, decide, type HiredAgent } from './runner.ts';

const entry: JournalEntry = {
  v: 1,
  decision: { agentId: 'volTarget-ETHUSDT-PERPETUAL', rule: 'volTarget', market: 'ETHUSDT-PERPETUAL', interval: '1d', candle: 1_795_000_000, close: 1670.48, values: { vol: 0.5873, target: 0.8513 }, out: { live: true, target: 0.8513, band: 0.15, mult: 0.85 } },
  order: { side: 'buy', usd: 25.13, why: 'rebalance to 85%' },
  held: { qty: 0.01, budgetUsd: 100, price: 1670.48 },
  at: 1_800_000_000_000,
};

test('the journal text is canonical: key order and float noise do not change the hash', () => {
  const shuffled = { at: entry.at, held: { price: 1670.48, budgetUsd: 100, qty: 0.01 }, order: entry.order, v: 1, decision: { ...entry.decision, values: { target: 0.8513, vol: 0.5873 } } } as JournalEntry;
  assert.equal(canonical(shuffled), canonical(entry));
  assert.equal(journalHash({ ...entry, held: { ...entry.held, qty: 0.1 + 0.2 - 0.29 } }), journalHash({ ...entry, held: { ...entry.held, qty: 0.01 } }), 'rounded to 10 significant digits');
  assert.equal(journalHash(entry), keccak256(stringToBytes(canonical(entry))));
  assert.match(journalHash(entry), /^0x[0-9a-f]{64}$/);
  assert.ok(!canonical({ a: 1, b: undefined }).includes('b'), 'undefined fields are left out, not written as null');
});

test('check: the hash only matches the exact inputs that were hashed', () => {
  const j = makeJournal(entry);
  assert.equal(verifyJournal(j), true);
  assert.equal(verifyJournal({ ...j, entry: { ...entry, decision: { ...entry.decision, close: 1671 } } }), false, 'a changed close fails');
  assert.equal(verifyJournal({ ...j, entry: { ...entry, order: { ...entry.order, usd: 25.14 } } }), false, 'a changed amount fails');
});

test('the on-chain note keeps the whole hash within the 120 characters the executor sends', () => {
  const h = journalHash(entry);
  const note = chainNote('ETH volTarget with a rather long name', { k: 'weight', pct: 85 }, 'auto', h);
  assert.ok(note.length <= 120);
  assert.ok(note.startsWith(h), 'the hash is first and never cut');
  assert.equal(noteWithHash(h, 'x'.repeat(200)).length, 120);
  assert.ok(!chainNote('ETH trend', { k: 'signalOn' }).startsWith('0x'), 'no journal, no hash');
});

test('a decided order carries its journal; without the rule inputs it carries none', () => {
  const h: HiredAgent = { id: 'h1', createdAt: 0, asset: 'ETH', perBuyUsd: 100, budgetUsd: 100, mode: 'auto', paused: false, fired: [], fills: [], log: [], source: { type: 'market', agentId: 'volTarget-ETHUSDT-PERPETUAL', kind: 'position', rule: 'volTarget', base: 'ETH' } };
  const d = decide(h, { kind: 'weight', target: 0.6, band: 0.15, price: 2000, decision: entry.decision }, 1_800_000_000_000);
  assert.equal(d.type, 'order');
  if (d.type !== 'order') return;
  assert.ok(d.order.journal && verifyJournal(d.order.journal));
  assert.deepEqual(d.order.journal!.entry.decision, entry.decision);
  assert.deepEqual(d.order.journal!.entry.order, { side: 'buy', usd: 60, qty: undefined, why: 'rebalance to 60%' });
  assert.deepEqual(d.order.journal!.entry.held, { qty: 0, budgetUsd: 100, price: 2000 });
  const plain = decide(h, { kind: 'weight', target: 0.6, band: 0.15, price: 2000 }, 1_800_000_000_000);
  assert.ok(plain.type === 'order' && plain.order.journal === undefined);
});
