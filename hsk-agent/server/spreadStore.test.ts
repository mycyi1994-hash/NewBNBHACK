import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpreads } from './spreadStore.ts';
import { KEEP_DAYS } from '../src/spread.ts';

test('the gap history is kept on disk, bounded to KEEP_DAYS, and read back by days', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'moa-spread-')), 'spread.json');
  const s = openSpreads(file), DAY = 86_400_000, now = Date.UTC(2026, 5, 1);
  s.add('BTC', { t: now - (KEEP_DAYS + 1) * DAY, pool: 1, hk: 1 }, now - (KEEP_DAYS + 1) * DAY);
  s.add('BTC', { t: now - 2 * DAY, pool: 2, hk: 2 }, now);
  s.add('BTC', { t: now - 1000, pool: 3, hk: 3 }, now);
  // the oldest fell out when the later ones were added
  assert.deepEqual(s.read('BTC', 14, now).map((p) => p.pool), [2, 3]);
  assert.deepEqual(s.read('BTC', 1, now).map((p) => p.pool), [3]);
  assert.deepEqual(s.read('ETH', 7, now), []);
  // and it survives a restart
  assert.deepEqual(openSpreads(file).read('BTC', 14, now).map((p) => p.pool), [2, 3]);
  assert.ok(readFileSync(file, 'utf8').length < 1000);
});
