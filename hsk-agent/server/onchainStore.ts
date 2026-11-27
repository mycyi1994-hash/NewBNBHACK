// The on-chain reader (src/onchain.ts): every READ_EVERY_MS the server reads the new Swap events of the WHSK/USDT pool
// from HSK Chain (only the blocks since its last read; the first read goes back KEEP_DAYS days) and the pool's
// liquidity within 2%. Kept in one JSON file in MOA_DATA_DIR, written like the other stores. Bounded: KEEP_DAYS of
// swaps and of liquidity records.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Asset } from '../src/intent.ts';
import { headBlock, poolState, swapsBetween } from '../src/dex.ts';
import { poolDepth } from '../src/depth.ts';
import { viewOf, type FlowSwap, type LiqPoint, type OnchainView } from '../src/onchain.ts';

export const READ_EVERY_MS = 10 * 60_000;
export const KEEP_DAYS = 30;
const DAY = 86_400_000, BLOCKS_PER_DAY = 43_200;

interface Data { swaps: FlowSwap[]; last?: number; since?: number; liq: LiqPoint[] }
export interface OnchainStore { view(now?: number): OnchainView | null; add(swaps: FlowSwap[], last: number, since: number | undefined, liq: LiqPoint | undefined, now?: number): void; last(): number | undefined }

export const onchainFile = (env: Record<string, string | undefined>, asset: Asset) => join(env.MOA_DATA_DIR || './data', `onchain-${asset}.json`);

export function openOnchain(asset: Asset, file?: string): OnchainStore {
  let data: Data = { swaps: [], liq: [] };
  if (file && existsSync(file)) {
    try { const v = JSON.parse(readFileSync(file, 'utf8')) as Data; if (v && Array.isArray(v.swaps)) data = { ...v, liq: Array.isArray(v.liq) ? v.liq : [] }; } catch { console.error(`[moa] could not read ${file}; reading the chain again`); }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  };
  return {
    last: () => data.last,
    view: (now = Date.now()) => (data.last === undefined || data.since === undefined ? null : viewOf(asset, data.swaps, Math.max(data.since, now - KEEP_DAYS * DAY), data.liq, now)),
    add: (swaps, last, since, liq, now = Date.now()) => {
      const seen = new Set(data.swaps.map((s) => `${s.tx}:${s.block}:${s.usdt}`));
      const fresh = swaps.filter((s) => !seen.has(`${s.tx}:${s.block}:${s.usdt}`));
      data.swaps = [...data.swaps, ...fresh].filter((s) => s.time >= now - KEEP_DAYS * DAY).sort((a, b) => a.block - b.block);
      data.last = last;
      if (since !== undefined && data.since === undefined) data.since = since;
      if (liq) data.liq = [...data.liq, liq].filter((x) => x.t >= now - KEEP_DAYS * DAY);
      save();
    },
  };
}

/** One read: new swaps since the last read (or KEEP_DAYS back on the first), and the liquidity within 2% now. */
export async function readOnce(asset: Asset, store: OnchainStore, now = Date.now()): Promise<string> {
  const head = await headBlock();
  const last = store.last();
  const from = last === undefined ? head - KEEP_DAYS * BLOCKS_PER_DAY : last + 1;
  const swaps = from <= head ? await swapsBetween(asset, from, head, head, now) : [];
  let liq: LiqPoint | undefined;
  try {
    const bands = poolDepth(await poolState(asset)).bands;
    const usd = (bands.find((b) => b.pct === -2)?.usdt ?? 0) + (bands.find((b) => b.pct === 2)?.usdt ?? 0);
    if (usd > 0) liq = { t: now, usd };
  } catch { /* liquidity left out of this read */ }
  store.add(swaps.map((s) => ({ block: s.block, time: s.time, side: s.side, usdt: s.usdt, price: s.price, tx: s.tx })), head, last === undefined ? now - (head - from) * 2000 : undefined, liq, now);
  return `${swaps.length} new swaps up to block ${head}`;
}

/** Read now and every `every` ms. Returns a function that stops it. */
export function startOnchain(asset: Asset, store: OnchainStore, every = READ_EVERY_MS): () => void {
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try { await readOnce(asset, store); } catch (e) { console.error(`[moa] on-chain read failed: ${e instanceof Error ? e.message : String(e)}`); } finally { busy = false; }
  };
  const first = setTimeout(pass, 8_000);
  const timer = setInterval(pass, Math.max(60_000, every));
  return () => { clearTimeout(first); clearInterval(timer); };
}
