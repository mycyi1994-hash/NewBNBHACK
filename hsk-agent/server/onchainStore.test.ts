import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOnchain, KEEP_DAYS } from './onchainStore.ts';

test('the on-chain store keeps new swaps once, drops what is older than KEEP_DAYS, and survives a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'moa-chain-')), 'onchain-HSK.json');
  const s = openOnchain('HSK', file), DAY = 86_400_000, now = Date.UTC(2026, 5, 1);
  assert.equal(s.view(now), null);
  const a = { block: 1, time: now - (KEEP_DAYS + 1) * DAY, side: 'buy' as const, usdt: 5, price: 0.08, tx: '0xa' };
  const b = { block: 2, time: now - 3_600_000, side: 'sell' as const, usdt: 7, price: 0.08, tx: '0xb' };
  s.add([a, b], 100, now - (KEEP_DAYS + 2) * DAY, { t: now, usd: 1000 }, now);
  s.add([b], 120, undefined, undefined, now);
  const v = s.view(now)!;
  assert.equal(v.week.count, 1);
  assert.equal(v.day.sell, 7);
  assert.equal(s.last(), 120);
  assert.equal(openOnchain('HSK', file).view(now)!.day.sell, 7);
});
