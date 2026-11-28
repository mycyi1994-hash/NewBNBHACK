import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { MARKETS } from '../src/cex.ts';
import { scorePosition } from '../src/agents.ts';
import { unpack, type AgentSet } from '../src/agentWire.ts';
import { openAgentCache, type Loader } from './agentCache.ts';
import { createApi } from './api.ts';
import { openStore } from './autoStore.ts';

const m = MARKETS.find((x) => x.symbol === 'BTCUSDT-PERPETUAL')!;
const bars = Array.from({ length: 1400 }, (_, i) => { const c = 100 * (1 + 0.3 * Math.sin(i / 40)) * 1.001 ** i; return { time: 1_600_000_000 + i * 86_400, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 }; });
const agent = scorePosition('basket', m, bars)!;

function loader() {
  const calls: string[] = [];
  const load: Loader = async (key) => { calls.push(key); return { agents: key.startsWith('m:') ? [agent] : [], fills: { [m.symbol]: { source: 'haircut', fee: 0.003, slip: 0.005, samples: 0, amountUsd: 100 } as never } }; };
  return { calls, load };
}

test('the cache scores a set once, answers from memory, refreshes in the background when old, and keeps it on disk', async () => {
  let clock = 1_000_000;
  const file = join(mkdtempSync(join(tmpdir(), 'moa-agents-')), 'agents-cache.json');
  const { calls, load } = loader();
  const c = openAgentCache(file, { load, every: 300_000, now: () => clock });
  const a = await c.get('m:BTCUSDT-PERPETUAL');
  assert.equal(a.at, 1_000_000);
  assert.equal((await c.get('m:BTCUSDT-PERPETUAL')).at, 1_000_000, 'the second ask is answered from memory');
  assert.equal(calls.length, 1);
  clock += 400_000;
  assert.equal((await c.get('m:BTCUSDT-PERPETUAL')).at, 1_000_000, 'an old set is still answered at once');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2, '... and refreshed in the background');
  assert.ok(existsSync(file));
  const again = openAgentCache(file, { load, every: 300_000, now: () => clock });
  assert.equal((await again.get('m:BTCUSDT-PERPETUAL')).at, clock, 'a restarted server answers from the file');
  assert.equal(calls.length, 2);
  // packing keeps every number a card shows
  const back = unpack(a.agents[0]);
  assert.equal(back.market?.symbol, m.symbol);
  assert.equal(back.total, agent.total);
  assert.equal(back.equity.length, agent.equity.length);
  assert.ok(Math.abs(back.equity[back.equity.length - 1].value - agent.equity[agent.equity.length - 1].value) < 1e-5);
});

test('GET /api/agents: one request, the sets for a coin with their time, gzip when asked', async () => {
  const { load } = loader();
  const api = createApi({ MOA_SESSION_SECRET: 's', MOA_DATA_DIR: mkdtempSync(join(tmpdir(), 'moa-api-')) }, { store: openStore(), agents: openAgentCache(undefined, { load }) });
  const server = createServer((req, res) => void api.handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${url}/api/agents?base=BTC`);
    const { sets } = (await r.json()) as { sets: AgentSet[] };
    assert.deepEqual(sets.map((s) => s.key), ['m:BTCUSDT-PERPETUAL', 'c:BTC']);
    assert.ok(sets.every((s) => typeof s.at === 'number'));
    assert.equal(sets[0].agents[0].rule, 'basket');
    assert.equal((await fetch(`${url}/api/agents?keys=nope`)).status, 400);
    const raw = await new Promise<{ enc?: string; body: Buffer }>((ok) => {
      import('node:http').then(({ get }) => get(`${url}/api/agents?keys=m:BTCUSDT-PERPETUAL`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
        const parts: Buffer[] = []; res.on('data', (d) => parts.push(d)); res.on('end', () => ok({ enc: res.headers['content-encoding'], body: Buffer.concat(parts) }));
      }));
    });
    assert.equal(raw.enc, 'gzip');
    assert.equal((JSON.parse(gunzipSync(raw.body).toString()) as { sets: AgentSet[] }).sets.length, 1);
  } finally { server.close(); }
});
