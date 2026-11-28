import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOnchain, passCalls, readOnce, nextPassIn, CALLS_PER_PASS, CATCH_UP_MS, CHUNK_BLOCKS, FIRST_DAY_CALLS, KEEP_DAYS, READ_EVERY_MS, type Chain } from './onchainStore.ts';
import type { FlowSwap } from '../src/onchain.ts';

const DAY = 86_400_000, BLOCKS_PER_DAY = 43_200, NOW = Date.UTC(2026, 5, 1), HEAD = 30_000_000;
const tmp = () => join(mkdtempSync(join(tmpdir(), 'moa-chain-')), 'onchain-HSK.json');
const calls = (from: number, to: number) => Math.ceil((to - from + 1) / 1000);

/** A stand-in node: one $10 buy every 2,000 blocks; it counts the log reads asked of it and can be told to fail. */
function fakeChain(head = HEAD) {
  const c = { head, logCalls: 0, asked: [] as [number, number][], failAt: undefined as number | undefined, liq: 0 };
  const chain: Chain = {
    head: async () => c.head,
    swaps: async (from, to, h, now) => {
      if (c.failAt !== undefined && from <= c.failAt && c.failAt <= to) throw new Error('the node did not answer');
      c.logCalls += calls(from, to); c.asked.push([from, to]);
      const out: FlowSwap[] = [];
      for (let b = Math.ceil(from / 2000) * 2000; b <= to; b += 2000) out.push({ block: b, time: now - (h - b) * 2000, side: 'buy', usdt: 10, price: 0.08, tx: `0x${b}` });
      return out;
    },
    liquidity: async () => { c.liq++; return 1000; },
  };
  return { c, chain };
}

test('a cold start reads the newest blocks first, a few log reads a pass, and serves the view once a day is read', async () => {
  const store = openOnchain('HSK', tmp()), { c, chain } = fakeChain();
  assert.equal(store.view(), null);
  const r1 = await readOnce(store, chain, NOW);
  assert.equal(c.asked[0][1], HEAD, 'the newest chunk first');
  assert.ok(r1.calls <= CALLS_PER_PASS && c.logCalls === r1.calls);
  assert.equal(r1.behind, true);
  assert.equal(store.view(), null, 'under a day read: no view yet');
  assert.ok(store.state().days > 0.5 && !store.state().complete);
  // A minute later, 30 blocks on: the new blocks, then further back.
  c.head += 30;
  const r2 = await readOnce(store, chain, NOW + 60_000);
  assert.ok(r2.calls <= CALLS_PER_PASS);
  const v = store.view()!;
  assert.ok(v, 'a day is read: the view is served');
  assert.equal(v.at, NOW + 60_000);
  assert.ok(v.at - v.since >= DAY && v.at - v.since < 2 * DAY, 'and it says how far back it reaches');
  assert.equal(v.day.count, 22, 'one swap every 2,000 blocks: 22 in the last 43,200');
  assert.equal(v.liquidity?.now, 1000);
  assert.equal(c.liq, 1, 'the liquidity is read once, not on every catch-up pass');
});

test('until there is a view, one pass may read a whole day: the first view comes with the first pass', async () => {
  const store = openOnchain('HSK'), { c, chain } = fakeChain();
  assert.equal(passCalls(store), FIRST_DAY_CALLS);
  const r = await readOnce(store, chain, NOW, passCalls(store));
  assert.ok(r.calls <= FIRST_DAY_CALLS && c.logCalls === r.calls);
  const v = store.view()!;
  assert.ok(v && v.at - v.since >= DAY, 'a day is read after one pass');
  assert.equal(passCalls(store), CALLS_PER_PASS, 'from then on the usual ration');
});

test('the whole 30 days arrive over many small passes; each block range is asked for once', async () => {
  const store = openOnchain('HSK'), { c, chain } = fakeChain();
  let passes = 0, behind = true;
  while (behind && passes < 100) {
    const before = c.logCalls;
    behind = (await readOnce(store, chain, NOW + passes * 60_000)).behind;
    assert.ok(c.logCalls - before <= CALLS_PER_PASS, 'never more than the pass allows');
    passes++; c.head += 30;
  }
  assert.equal(behind, false);
  assert.ok(passes >= 40 && passes <= 60, `about 45 passes (${passes})`);
  assert.equal(store.state().complete, true);
  assert.equal(store.state().days, KEEP_DAYS);
  const blocks = c.asked.reduce((n, [a, b]) => n + (b - a + 1), 0);
  assert.ok(blocks <= KEEP_DAYS * BLOCKS_PER_DAY + passes * 30, 'no range was read twice');
  // Up to date: a pass is one log read for the new blocks.
  const before = c.logCalls;
  assert.equal((await readOnce(store, chain, NOW + passes * 60_000)).behind, false);
  assert.equal(c.logCalls - before, 1);
});

test('a failed chunk keeps what was read, and only that chunk is asked for again', async () => {
  const store = openOnchain('HSK', tmp()), { c, chain } = fakeChain();
  c.failAt = HEAD - 2 * CHUNK_BLOCKS - 10;   // inside the third chunk back from the head
  await assert.rejects(readOnce(store, chain, NOW), /did not answer/);
  assert.deepEqual(store.range(), { first: HEAD - 2 * CHUNK_BLOCKS + 1, last: HEAD }, 'the two chunks before the failure are kept');
  assert.equal(c.logCalls, 10);
  c.failAt = undefined;
  const r = await readOnce(store, chain, NOW + 60_000);
  assert.deepEqual(c.asked[2], [HEAD - 3 * CHUNK_BLOCKS + 1, HEAD - 2 * CHUNK_BLOCKS], 'the next pass starts at the chunk that failed');
  assert.ok(r.calls <= CALLS_PER_PASS);
});

test('a restart continues where the read stopped', async () => {
  const file = tmp(), { c, chain } = fakeChain();
  await readOnce(openOnchain('HSK', file), chain, NOW);
  const first = openOnchain('HSK', file).range().first!;
  const again = openOnchain('HSK', file);
  await readOnce(again, chain, NOW + 60_000);
  assert.ok(c.asked.slice(6).every(([, to]) => to < first), 'nothing read before the restart is asked for again');
  assert.equal(again.range().last, HEAD);
  assert.ok(again.range().first! < first);
  assert.ok(openOnchain('HSK', file).view(), 'and the view is there straight after the next restart');
});

test('after time away it catches up from where it was; after more than is kept it starts over from the head', async () => {
  const store = openOnchain('HSK'), { c, chain } = fakeChain();
  await readOnce(store, chain, NOW);
  await readOnce(store, chain, NOW + 60_000);
  const had = store.view()!;
  // Two days away: 86,400 new blocks, three passes of catching up. The view stays as of the last complete read.
  c.head += 2 * BLOCKS_PER_DAY;
  const r = await readOnce(store, chain, NOW + 2 * DAY);
  assert.equal(r.behind, true);
  assert.equal(store.view()!.at, had.at, 'not up to the head yet: the view still says when it was true');
  await readOnce(store, chain, NOW + 2 * DAY + 60_000);
  await readOnce(store, chain, NOW + 2 * DAY + 120_000);
  assert.equal(store.range().last, c.head);
  assert.equal(store.view()!.at, NOW + 2 * DAY + 120_000);
  // Forty days away: nothing kept joins up with now.
  c.head += 40 * BLOCKS_PER_DAY;
  await readOnce(store, chain, NOW + 42 * DAY);
  assert.equal(store.range().last, c.head);
  assert.ok(store.range().first! > c.head - CALLS_PER_PASS * 1000);
});

test('the next pass: every ten minutes when up to date, half a minute while catching up, slower after each failure', () => {
  assert.equal(nextPassIn(false, 0), READ_EVERY_MS);
  assert.equal(nextPassIn(true, 0), CATCH_UP_MS);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => nextPassIn(true, n)), [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, READ_EVERY_MS, READ_EVERY_MS]);
});

test('the store keeps a swap once, drops what is older than KEEP_DAYS, and reads a file written before the range was kept', () => {
  const file = tmp(), s = openOnchain('HSK', file);
  const old = { block: HEAD - (KEEP_DAYS + 1) * BLOCKS_PER_DAY, time: NOW - (KEEP_DAYS + 1) * DAY, side: 'buy' as const, usdt: 5, price: 0.08, tx: '0xa' };
  const b = { block: HEAD - 1800, time: NOW - 3_600_000, side: 'sell' as const, usdt: 7, price: 0.08, tx: '0xb' };
  s.add([old, b], { from: HEAD - 2 * BLOCKS_PER_DAY, to: HEAD, head: HEAD }, NOW);
  s.add([b], { from: HEAD + 1, to: HEAD + 30, head: HEAD + 30 }, NOW + 60_000);
  assert.throws(() => s.add([], { from: HEAD + 500, to: HEAD + 600, head: HEAD + 600 }, NOW), /do not touch/);
  const v = openOnchain('HSK', file).view()!;
  assert.equal(v.week.count, 1);
  assert.equal(v.day.sell, 7);
  assert.deepEqual(s.range(), { first: HEAD - 2 * BLOCKS_PER_DAY, last: HEAD + 30 });
  // The earlier format: no range start and no read time; its one read went back the whole 30 days.
  const legacy = tmp();
  writeFileSync(legacy, JSON.stringify({ swaps: [b], last: HEAD, since: NOW - KEEP_DAYS * DAY, liq: [{ t: NOW, usd: 9 }] }));
  const l = openOnchain('HSK', legacy);
  assert.equal(l.view()!.day.sell, 7);
  assert.equal(l.state().complete, true);
});
