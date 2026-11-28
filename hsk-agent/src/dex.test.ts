import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, type Hex } from 'viem';
import { POOLS, poolDetail, poolState, setLogPace, swapsBetween } from './dex.ts';

/** A stand-in node: counts the requests by method, answers log reads with nothing and Multicall3 from a tiny pool. */
const asked: { method: string; at: number }[] = [];
const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
function inner(data: string): Hex {
  const sel = data.slice(0, 10);
  if (sel === '0x3850c7bd') return `0x${word(2n ** 96n)}${word(0)}${word(0).repeat(5)}`;         // slot0: price 1, tick 0
  if (sel === '0x1a686502') return `0x${word(10n ** 18n)}`;                                       // liquidity
  if (sel === '0xd0c93a7c') return `0x${word(60)}`;                                               // tick spacing
  if (sel === '0x5339c296') return `0x${word(data.endsWith(word(0)) ? 2 : 0)}`;                   // bitmap: word 0 has bit 1 set (tick 60)
  if (sel === '0xf30dba93') return `0x${word(7)}${word(5)}${word(0).repeat(6)}`;                  // ticks(60): net 5
  if (sel === '0x70a08231') return `0x${word(123_000_000)}`;                                      // a balance
  if (sel === '0x42cbb15c') return `0x${word(30_000_000)}`;                                       // Multicall3's block number
  throw new Error(`unexpected read ${sel}`);
}
globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
  const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ to: string; data: Hex }] };
  asked.push({ method, at: Date.now() });
  let result: unknown = [];
  if (method === 'eth_call') {
    const calls = decodeFunctionData({ abi: multicall3Abi, data: params[0].data }).args![0] as readonly { callData: Hex }[];
    result = encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map((c) => ({ success: true, returnData: inner(c.callData) })) });
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

test('a pool is read in three requests (its price, the tick bitmaps, the ticks), not one per value', async () => {
  asked.length = 0;
  const s = await poolState('HSK');
  assert.deepEqual(asked.map((a) => a.method), ['eth_call', 'eth_call', 'eth_call']);
  assert.deepEqual(s.ticks, [{ tick: 60, net: 5 }]);
  assert.deepEqual([s.tick, s.sqrtPrice, s.liquidity], [0, 1, 1e18]);
  asked.length = 0;
  const d = await poolDetail('HSK', 0);
  assert.equal(asked.filter((a) => a.method === 'eth_call').length, 1, 'price, both balances and the block: one request');
  assert.deepEqual([d.head, d.reserveUsdt, d.price], [30_000_000, 123, 10 ** (POOLS.HSK.decimals - 6)]);
});

test('log reads wait their turn: a burst, then the ration per minute; other reads are not rationed', async () => {
  setLogPace(1200, 2);   // 2 at once, then one every 50 ms
  asked.length = 0;
  const t0 = Date.now();
  await swapsBetween('HSK', 1, 6000, 6000);   // six log reads of 1,000 blocks
  const at = asked.filter((a) => a.method === 'eth_getLogs').map((a) => a.at - t0);
  assert.equal(at.length, 6);
  assert.ok(at[1] < 40, `the burst goes at once (${at})`);
  assert.ok(at[5] >= 4 * 50 - 15, `the other four are spaced out (${at})`);
  const before = Date.now();
  await poolState('HSK');
  assert.ok(Date.now() - before < 40, 'a price read does not wait behind the ration');
  setLogPace(null);
  asked.length = 0;
  const t1 = Date.now();
  await swapsBetween('HSK', 1, 6000, 6000);
  assert.ok(Date.now() - t1 < 40, 'with no ration (the browser) nothing waits');
});
