// HSKSwap (Uniswap V3 fork) pool details read straight from HSK Chain mainnet: reserves, recent swaps, price history.
import { decodeFunctionResult, encodeFunctionData, multicall3Abi, type Hex } from 'viem';
import type { Asset } from './intent.ts';
import type { PoolState } from './depth.ts';

const RPC = 'https://mainnet.hsk.xyz';
export const EXPLORER = 'https://hsk.blockscout.com';
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const USDT = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029';
const BLOCKS_PER_DAY = 43_200; // 2-second blocks

export const POOLS: Record<Asset, { pool: string; token: string; decimals: number; symbol: string }> = {
  HSK: { pool: '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc', token: '0xb210d2120d57b758ee163cffb43e73728c471cf1', decimals: 18, symbol: 'WHSK' },
  ETH: { pool: '0xb92b79ed6b370d5cfee2e14b1d0983c258304c16', token: '0xefd4bc9afd210517803f293ababd701caeecdfd0', decimals: 18, symbol: 'WETH' },
  BTC: { pool: '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a', token: '0x6119ca49a79f5825c8b345f8d7ac36b272565b14', decimals: 8, symbol: 'WBTC' },
};

let id = 1;
async function send<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error || j.result === undefined) throw new Error(j.error?.message ?? 'empty RPC result');
  return j.result;
}
/**
 * At most this many calls to the node at once, from everything in this process. A day of one pool's swaps is 44 log
 * reads and three pools were read side by side, 8 each: a starting server sent its first 200 calls in a few seconds
 * and the node then stopped answering it for minutes, vault reads included.
 */
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];
/**
 * The server's ration of log reads (setLogPace): `burst` at once, then `perMinute`. Log reads are the bulk of what is
 * asked of the node (a day of one pool's swaps is 44 of them) and none of them is urgent, so they wait their turn here;
 * price and depth reads are few and are not rationed. Off in the browser, where one person reads one pool.
 */
let pace: { perMinute: number; burst: number; tokens: number; at: number } | null = null;
export function setLogPace(perMinute: number | null, burst = 10): void {
  pace = perMinute && perMinute > 0 ? { perMinute, burst, tokens: burst, at: Date.now() } : null;
}
let paceLine: Promise<void> = Promise.resolve();
/** Wait for one log read's turn: first come, first served. */
function logTurn(): Promise<void> {
  const turn = paceLine.then(async () => {
    const p = pace;
    if (!p) return;
    const now = Date.now();
    p.tokens = Math.min(p.burst, p.tokens + ((now - p.at) / 60_000) * p.perMinute);
    p.at = now;
    if (p.tokens < 1) {
      const wait = ((1 - p.tokens) / p.perMinute) * 60_000;
      await new Promise((go) => setTimeout(go, wait));
      p.tokens = 1; p.at = Date.now();
    }
    p.tokens -= 1;
  });
  paceLine = turn;
  return turn;
}
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  if (pace && method === 'eth_getLogs') await logTurn();
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((go) => waiting.push(go));
  inFlight++;
  try { return await send<T>(method, params); } finally { inFlight--; waiting.shift()?.(); }
}
/** Multicall3 on HSK Chain: many reads in one call to the node, all at the same block. */
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** Several contract reads as one request. Any read that fails fails them all, as one failed request did before. */
async function readAll(calls: { to: string; data: string }[]): Promise<string[]> {
  if (!calls.length) return [];
  const data = encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls.map((c) => ({ target: c.to as Hex, allowFailure: false, callData: c.data as Hex }))] });
  const out = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: await rpc<Hex>('eth_call', [{ to: MULTICALL, data }, 'latest']) });
  return out.map((r) => r.returnData);
}
const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const s256 = (h: string) => { let v = BigInt('0x' + h); if (v >= 2n ** 255n) v -= 2n ** 256n; return v; };

export interface Swap { block: number; time: number; side: 'buy' | 'sell'; baseQty: number; usdt: number; price: number; tx: string }
export interface PoolDetail { asset: Asset; price: number; reserveBase: number; reserveUsdt: number; swaps: Swap[]; head: number; at: number }

/** The chain's latest block number. */
export const headBlock = async () => parseInt(await rpc<string>('eth_blockNumber', []), 16);

/**
 * Every swap in the pool between two blocks, newest first. Times are estimated from 2-second blocks back from `head`
 * read at `now`. The RPC caps eth_getLogs at about 1,000 blocks per call, so this asks in 1,000-block steps, 8 at a time.
 */
export async function swapsBetween(asset: Asset, from: number, to: number, head: number, now = Date.now()): Promise<Swap[]> {
  const p = POOLS[asset];
  const scale = 10 ** (p.decimals - 6);
  const starts: number[] = [];
  for (let f = Math.max(0, from); f <= to; f += 1000) starts.push(f);
  const logs: { blockNumber: string; data: string; transactionHash: string }[] = [];
  let k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (k < starts.length) {
      const f = starts[k++];
      const got = await rpc<typeof logs>('eth_getLogs', [{ address: p.pool, fromBlock: '0x' + f.toString(16), toBlock: '0x' + Math.min(to, f + 999).toString(16), topics: [SWAP_TOPIC] }]);
      logs.push(...got);
    }
  }));
  return logs.map((l): Swap => {
    const d = l.data.slice(2);
    const a0 = Number(s256(d.slice(0, 64))) / 10 ** p.decimals;
    const a1 = Number(s256(d.slice(64, 128))) / 1e6;
    const sp = Number(BigInt('0x' + d.slice(128, 192))) / 2 ** 96;
    const block = parseInt(l.blockNumber, 16);
    return { block, time: now - (head - block) * 2000, side: a1 > 0 ? 'buy' : 'sell', baseQty: Math.abs(a0), usdt: Math.abs(a1), price: sp * sp * scale, tx: l.transactionHash };
  }).sort((a, b) => b.block - a.block);
}

export async function poolDetail(asset: Asset, days = 1): Promise<PoolDetail> {
  const p = POOLS[asset];
  const scale = 10 ** (p.decimals - 6);
  // The price, both balances and the block they were read at, in one request (0x42cbb15c: Multicall3's own block number).
  const [slot0, balBase, balUsdt, headHex] = await readAll([
    { to: p.pool, data: '0x3850c7bd' },
    { to: p.token, data: '0x70a08231' + pad(p.pool) },
    { to: USDT, data: '0x70a08231' + pad(p.pool) },
    { to: MULTICALL, data: '0x42cbb15c' },
  ]);
  const head = Number(BigInt(headHex));
  const sq = Number(BigInt(slot0.slice(0, 66))) / 2 ** 96;
  const now = Date.now();

  const swaps = await swapsBetween(asset, head - days * BLOCKS_PER_DAY, head, head, now);

  return {
    asset,
    price: sq * sq * scale,
    reserveBase: Number(BigInt(balBase)) / 10 ** p.decimals,
    reserveUsdt: Number(BigInt(balUsdt)) / 1e6,
    swaps,
    head,
    at: now,
  };
}

/* ---------- depth: the liquidity around the price, tick by tick ---------- */

const int256 = (v: number) => (v < 0 ? 2n ** 256n + BigInt(v) : BigInt(v)).toString(16).padStart(64, '0');

/**
 * The pool's price, the liquidity in range and every initialized tick within reach of the price (about a 4x move
 * either way). Three requests (price, then the tick bitmaps around it, then those ticks) where it was one per read.
 */
export async function poolState(asset: Asset): Promise<PoolState> {
  const pool = POOLS[asset].pool;
  const [slot0, liq, spacingHex] = await readAll(['0x3850c7bd', '0x1a686502', '0xd0c93a7c'].map((data) => ({ to: pool, data })));
  const tick = Number(s256(slot0.slice(66, 130))), spacing = Number(s256(spacingHex.slice(2)));
  const word = Math.floor(tick / spacing) >> 8;
  const words = [word - 1, word, word + 1];
  const maps = await readAll(words.map((w) => ({ to: pool, data: '0x5339c296' + int256(w) })));
  const at: number[] = [];
  maps.forEach((hex, i) => { const bits = BigInt(hex); for (let b = 0; b < 256; b++) if ((bits >> BigInt(b)) & 1n) at.push(((words[i] << 8) + b) * spacing); });
  const nets = await readAll(at.map((t) => ({ to: pool, data: '0xf30dba93' + int256(t) })));
  return {
    sqrtPrice: Number(BigInt(slot0.slice(0, 66))) / 2 ** 96, tick, liquidity: Number(BigInt(liq)),
    ticks: at.map((t, i) => ({ tick: t, net: Number(s256(nets[i].slice(66, 130))) })),
  };
}
