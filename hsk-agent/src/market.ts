// Live prices: HSKSwap pool spot price read from HSK Chain mainnet, next to the exchange price (Gate).
// Every value carries its source state; nothing is filled in when a source fails.

import type { Asset } from './intent.ts';

const RPC = 'https://mainnet.hsk.xyz';
const POOLS: Record<Asset, { address: string; scale: number; pair: string }> = {
  // token0 is the base asset in all three pools; scale = 10^(token0 decimals - USDT decimals)
  HSK: { address: '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc', scale: 1e12, pair: 'HSK_USDT' },
  ETH: { address: '0xb92b79ed6b370d5cfee2e14b1d0983c258304c16', scale: 1e12, pair: 'ETH_USDT' },
  BTC: { address: '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a', scale: 1e2, pair: 'BTC_USDT' },
};
const SLOT0 = '0x3850c7bd';

export type SourceState = { state: 'live'; at: number } | { state: 'unavailable'; reason: string };

export interface Quote {
  asset: Asset;
  pool?: number;
  poolSource: SourceState;
  exchange?: number;
  exchangeChange24h?: number;
  exchangeSource: SourceState;
  /** pool / exchange - 1, only when both are live */
  gap?: number;
}

async function poolPrice(asset: Asset): Promise<number> {
  const { address, scale } = POOLS[asset];
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: SLOT0 }, 'latest'] }),
  });
  const j = (await r.json()) as { result?: string; error?: { message: string } };
  if (!j.result || j.result.length < 66) throw new Error(j.error?.message ?? 'empty RPC result');
  const sqrt = Number(BigInt('0x' + j.result.slice(2, 66))) / 2 ** 96;
  return sqrt * sqrt * scale;
}

async function exchangePrices(): Promise<Map<string, { last: number; change: number }>> {
  const rows = await Promise.all(
    Object.values(POOLS).map(async ({ pair }) => {
      const r = await fetch(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`);
      if (!r.ok) throw new Error(`exchange HTTP ${r.status}`);
      return ((await r.json()) as { currency_pair: string; last: string; change_percentage: string }[])[0];
    }),
  );
  return new Map(rows.filter(Boolean).map((x) => [x.currency_pair, { last: Number(x.last), change: Number(x.change_percentage) }]));
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadQuotes(): Promise<Quote[]> {
  const assets = Object.keys(POOLS) as Asset[];
  const [pools, ex] = await Promise.all([
    Promise.allSettled(assets.map(poolPrice)),
    exchangePrices().then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
  ]);
  const now = Date.now();
  return assets.map((asset, i) => {
    const q: Quote = { asset, poolSource: { state: 'unavailable', reason: 'not loaded' }, exchangeSource: { state: 'unavailable', reason: 'not loaded' } };
    const p = pools[i];
    if (p.status === 'fulfilled') { q.pool = p.value; q.poolSource = { state: 'live', at: now }; }
    else q.poolSource = { state: 'unavailable', reason: reason(p.reason) };
    if (ex.ok) {
      const t = ex.v.get(POOLS[asset].pair);
      if (t) { q.exchange = t.last; q.exchangeChange24h = t.change; q.exchangeSource = { state: 'live', at: now }; }
      else q.exchangeSource = { state: 'unavailable', reason: 'pair not listed' };
    } else q.exchangeSource = { state: 'unavailable', reason: reason(ex.e) };
    if (q.pool !== undefined && q.exchange !== undefined) q.gap = q.pool / q.exchange - 1;
    return q;
  });
}

export function fmtPrice(v: number): string {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return v.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}
