// The on-chain reader (src/onchain.ts): the Swap events of the WHSK/USDT pool on HSK Chain, and the pool's liquidity
// within 2%. Kept in one JSON file in MOA_DATA_DIR, written like the other stores. Bounded: KEEP_DAYS of swaps and of
// liquidity records.
//
// The store remembers the block range it has read (first..last). Every pass reads the new blocks up to the chain's
// head, then goes further back in time, CHUNK_BLOCKS at a time, until KEEP_DAYS are read. Each chunk is saved as
// soon as it is read, so a failed call costs one chunk (retried on the next pass) and a restart continues where the
// last one stopped. A pass never asks for more than CALLS_PER_PASS log reads (FIRST_DAY_CALLS until there is a view
// to serve), and the server's log reads are rationed per minute as a whole (src/dex.ts setLogPace). The view is
// served once a day is read and says from when (`since`); it grows to KEEP_DAYS over the next passes.
// (The first read used to ask for all 30 days at once, about 1,300 log reads: one failed call lost them all, and it
// started again every ten minutes, which is what made the node stop answering this server.)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Asset } from '../src/intent.ts';
import { headBlock, poolState, swapsBetween } from '../src/dex.ts';
import { poolDepth } from '../src/depth.ts';
import { viewOf, type FlowSwap, type LiqPoint, type OnchainView } from '../src/onchain.ts';

export const READ_EVERY_MS = 10 * 60_000;
/** While there is still history to read, the next pass comes this soon after the last one ended. */
export const CATCH_UP_MS = 30_000;
export const KEEP_DAYS = 30;
/** One chunk: 5,000 blocks, five log reads (the node answers about 1,000 blocks a call), under three hours of chain. */
export const CHUNK_BLOCKS = 5_000;
/** The most log reads one pass asks for: 30,000 blocks, about 17 hours of chain. */
export const CALLS_PER_PASS = 30;
/** Until there is a view to serve, a pass may read a whole day (44 log reads and one to spare), so the first view takes one pass. */
export const FIRST_DAY_CALLS = 45;
/** The view is served once this much is read, so "the last 24 hours" is whole. */
export const SERVE_AFTER_MS = 86_400_000;
const DAY = 86_400_000, BLOCK_MS = 2000, BLOCKS_PER_DAY = DAY / BLOCK_MS;

interface Data {
  swaps: FlowSwap[]; liq: LiqPoint[];
  /** The block range read: every swap from `first` to `last` is in `swaps` (or was dropped as older than KEEP_DAYS). */
  first?: number; last?: number;
  /** The time of block `first`: nothing before it is known. */
  since?: number;
  /** When the range last reached the chain's head (ms): the moment the view is true for. */
  at?: number;
}
/** Where the read stands, for the API and the log. */
export interface ReadState { since: number | null; at: number | null; days: number; wanted: number; complete: boolean }
export interface OnchainStore {
  /** The flows as of the last read that reached the head; null until a day is read. */
  view(): OnchainView | null;
  range(): { first?: number; last?: number };
  state(): ReadState;
  /**
   * The swaps of blocks `from`..`to`, read at `now` with the chain's head at `head`. The chunk must touch the range
   * read so far (just above it or just below it); the first chunk starts the range.
   */
  add(swaps: FlowSwap[], chunk: { from: number; to: number; head: number }, now?: number): void;
  liquidity(p: LiqPoint): void;
  /** When the liquidity was last recorded. */
  liquidityAt(): number | undefined;
  /** Forget the range (the chain moved further than KEEP_DAYS past it): the next read starts from the head. */
  reset(): void;
}

export const onchainFile = (env: Record<string, string | undefined>, asset: Asset) => join(env.MOA_DATA_DIR || './data', `onchain-${asset}.json`);

export function openOnchain(asset: Asset, file?: string): OnchainStore {
  let data: Data = { swaps: [], liq: [] };
  if (file && existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as Data;
      if (v && Array.isArray(v.swaps)) {
        data = { ...v, liq: Array.isArray(v.liq) ? v.liq : [] };
        // A file from before the range was kept: its one read went all the way back, and its last record says when.
        if (data.last !== undefined && data.at === undefined) data.at = data.liq[data.liq.length - 1]?.t ?? data.since;
      }
    } catch { console.error(`[moa] could not read ${file}; reading the chain again`); }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  };
  const state = (): ReadState => {
    const since = data.since ?? null, at = data.at ?? null;
    const days = since !== null && at !== null ? Math.min(KEEP_DAYS, Math.max(0, (at - since) / DAY)) : 0;
    return { since, at, days: Number(days.toFixed(2)), wanted: KEEP_DAYS, complete: days >= KEEP_DAYS - 0.01 };
  };
  return {
    range: () => ({ first: data.first, last: data.last }),
    state,
    view: () => {
      const { since, at } = data;
      if (data.last === undefined || since === undefined || at === undefined || at - since < SERVE_AFTER_MS) return null;
      return viewOf(asset, data.swaps, Math.max(since, at - KEEP_DAYS * DAY), data.liq, at);
    },
    add: (swaps, { from, to, head }, now = Date.now()) => {
      const timeOf = (block: number) => now - (head - block) * BLOCK_MS;
      if (data.last === undefined) { data.first = from; data.last = to; data.since = timeOf(from); }
      else if (from === data.last + 1) data.last = to;
      else if (data.first !== undefined && to === data.first - 1) { data.first = from; data.since = timeOf(from); }
      else throw new Error(`blocks ${from}..${to} do not touch the range read (${data.first ?? '?'}..${data.last})`);
      const seen = new Set(data.swaps.map((s) => `${s.tx}:${s.block}:${s.usdt}`));
      const fresh = swaps.filter((s) => !seen.has(`${s.tx}:${s.block}:${s.usdt}`));
      data.swaps = [...data.swaps, ...fresh].filter((s) => s.time >= now - KEEP_DAYS * DAY).sort((a, b) => a.block - b.block);
      if (data.last >= head) data.at = now;
      save();
    },
    liquidity: (p) => { data.liq = [...data.liq, p].filter((x) => x.t >= p.t - KEEP_DAYS * DAY); save(); },
    liquidityAt: () => data.liq[data.liq.length - 1]?.t,
    reset: () => { data = { swaps: [], liq: data.liq }; save(); },
  };
}

/** What a read reaches on the chain, so a test can stand in for the node. */
export interface Chain {
  head(): Promise<number>;
  swaps(from: number, to: number, head: number, now: number): Promise<FlowSwap[]>;
  /** The USDT it takes to move the pool 2% either way, added up. */
  liquidity(): Promise<number>;
}
export const liveChain = (asset: Asset): Chain => ({
  head: headBlock,
  swaps: async (from, to, head, now) => (await swapsBetween(asset, from, to, head, now)).map((s) => ({ block: s.block, time: s.time, side: s.side, usdt: s.usdt, price: s.price, tx: s.tx })),
  liquidity: async () => {
    const bands = poolDepth(await poolState(asset)).bands;
    return (bands.find((b) => b.pct === -2)?.usdt ?? 0) + (bands.find((b) => b.pct === 2)?.usdt ?? 0);
  },
});

const callsFor = (from: number, to: number) => Math.ceil((to - from + 1) / 1000);
/**
 * One pass: the new blocks up to the head, then older blocks while the pass's calls last and KEEP_DAYS are not read
 * yet, a chunk at a time, each saved when read. A chunk that fails ends the pass by throwing; what was read before it
 * is kept and the next pass tries that chunk again. Returns whether there is more to read soon (`behind`).
 */
export async function readOnce(store: OnchainStore, chain: Chain, now = Date.now(), maxCalls = CALLS_PER_PASS): Promise<{ head: number; calls: number; swaps: number; behind: boolean }> {
  const head = await chain.head();
  const floor = Math.max(0, head - KEEP_DAYS * BLOCKS_PER_DAY);
  let calls = 0, swaps = 0;
  const read = async (from: number, to: number) => {
    const got = await chain.swaps(from, to, head, now);
    calls += callsFor(from, to); swaps += got.length;
    store.add(got, { from, to, head }, now);
  };
  // The server was away for longer than is kept: what it has no longer joins up with now.
  if ((store.range().last ?? head) < floor) store.reset();
  // Up to the head first (on the very first read: the newest chunk).
  /** The blocks the next chunk may cover: a whole chunk, or what is left of this pass's calls. */
  const room = () => Math.min(CHUNK_BLOCKS, (maxCalls - calls) * 1000);
  for (let from = (store.range().last ?? head - CHUNK_BLOCKS) + 1; from <= head; ) {
    if (room() <= 0) return { head, calls, swaps, behind: true };
    const to = Math.min(head, from + room() - 1);
    await read(from, to);
    from = to + 1;
  }
  // The liquidity now, once the flows are up to date. Catch-up passes come every minute: they do not read it again.
  if (now - (store.liquidityAt() ?? 0) >= READ_EVERY_MS / 2) {
    try { const usd = await chain.liquidity(); if (usd > 0) store.liquidity({ t: now, usd }); } catch { /* liquidity left out of this read */ }
  }
  // Then further back.
  for (let first = store.range().first; first !== undefined && first > floor; first = store.range().first) {
    if (room() <= 0) return { head, calls, swaps, behind: true };
    await read(Math.max(floor, first - room()), first - 1);
  }
  return { head, calls, swaps, behind: false };
}

/** The log reads the next pass may ask for: a whole day while nothing can be served yet, the usual ration after. */
export const passCalls = (store: Pick<OnchainStore, 'view'>) => (store.view() ? CALLS_PER_PASS : FIRST_DAY_CALLS);

/** How long until the next pass: soon while catching up, a minute and then longer after each failure in a row, never past `every`. */
export const nextPassIn = (behind: boolean, fails: number, every = READ_EVERY_MS) => (fails > 0 ? Math.min(every, 30_000 * 2 ** fails) : behind ? Math.min(every, CATCH_UP_MS) : every);

/** Read now and again after each pass (nextPassIn). Returns a function that stops it. */
export function startOnchain(asset: Asset, store: OnchainStore, every = READ_EVERY_MS, chain: Chain = liveChain(asset)): () => void {
  let stopped = false, fails = 0, timer: ReturnType<typeof setTimeout>;
  const pass = async () => {
    let behind = false;
    try {
      const r = await readOnce(store, chain, Date.now(), passCalls(store));
      behind = r.behind; fails = 0;
      const s = store.state();
      if (r.behind || r.calls > 1) console.log(`[moa] on-chain: ${r.calls} log reads, ${r.swaps} swaps, ${s.days.toFixed(1)} of ${s.wanted} days read${r.behind ? ', more next pass' : ''}`);
    } catch (e) {
      fails++;
      console.error(`[moa] on-chain read failed (${fails} in a row; what was read is kept): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stopped) timer = setTimeout(pass, nextPassIn(behind, fails, Math.max(60_000, every)));   // MOA_ONCHAIN_MS: a minute at least
  };
  timer = setTimeout(pass, 8_000);
  return () => { stopped = true; clearTimeout(timer); };
}
