// HSKSwap (Uniswap V3 fork) pool details read straight from HSK Chain mainnet: reserves, recent swaps, price history.
import type { Asset } from './intent.ts';

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
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error || j.result === undefined) throw new Error(j.error?.message ?? 'empty RPC result');
  return j.result;
}
const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const s256 = (h: string) => { let v = BigInt('0x' + h); if (v >= 2n ** 255n) v -= 2n ** 256n; return v; };

export interface Swap { block: number; time: number; side: 'buy' | 'sell'; baseQty: number; usdt: number; price: number; tx: string }
export interface PoolDetail { asset: Asset; price: number; reserveBase: number; reserveUsdt: number; swaps: Swap[]; head: number; at: number }

export async function poolDetail(asset: Asset, days = 1): Promise<PoolDetail> {
  const p = POOLS[asset];
  const scale = 10 ** (p.decimals - 6);
  const [slot0, balBase, balUsdt, headHex] = await Promise.all([
    rpc<string>('eth_call', [{ to: p.pool, data: '0x3850c7bd' }, 'latest']),
    rpc<string>('eth_call', [{ to: p.token, data: '0x70a08231' + pad(p.pool) }, 'latest']),
    rpc<string>('eth_call', [{ to: USDT, data: '0x70a08231' + pad(p.pool) }, 'latest']),
    rpc<string>('eth_blockNumber', []),
  ]);
  const head = parseInt(headHex, 16);
  const sq = Number(BigInt(slot0.slice(0, 66))) / 2 ** 96;
  const now = Date.now();

  // the RPC caps eth_getLogs at about 1,000 blocks per call
  const from = head - days * BLOCKS_PER_DAY;
  const starts: number[] = [];
  for (let f = from; f <= head; f += 1000) starts.push(f);
  const logs: { blockNumber: string; data: string; transactionHash: string }[] = [];
  let k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (k < starts.length) {
      const f = starts[k++];
      const got = await rpc<typeof logs>('eth_getLogs', [{ address: p.pool, fromBlock: '0x' + f.toString(16), toBlock: '0x' + Math.min(head, f + 999).toString(16), topics: [SWAP_TOPIC] }]);
      logs.push(...got);
    }
  }));
  const swaps = logs.map((l): Swap => {
    const d = l.data.slice(2);
    const a0 = Number(s256(d.slice(0, 64))) / 10 ** p.decimals;
    const a1 = Number(s256(d.slice(64, 128))) / 1e6;
    const sp = Number(BigInt('0x' + d.slice(128, 192))) / 2 ** 96;
    const block = parseInt(l.blockNumber, 16);
    return { block, time: now - (head - block) * 2000, side: a1 > 0 ? 'buy' : 'sell', baseQty: Math.abs(a0), usdt: Math.abs(a1), price: sp * sp * scale, tx: l.transactionHash };
  }).sort((a, b) => b.block - a.block);

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
