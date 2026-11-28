// The agents on "auto": every few minutes the server asks each one what it wants to do (the same decide() the app
// uses) and, when it wants to trade, sends the order to its owner's vault at once. No model is called from here:
// an agent's signal is its rule on closed candles, and for Moa AI the target its model last recorded
// (server/aiPilot.ts decides that on its own clock; this runner only reads it).
// It also carries out any stop-loss that is due on a vault it knows about; the vault decides whether one applies.
// A daily spending limit and a stop-loss on the vault are recommended in the hire sheet and are the owner's choice:
// the agent's own budget is the only cap this runner applies by itself.
import { agentById, ruleInterval, scoreMadeLive, SIGNAL_MARKETS } from '../src/agents.ts';
import { intervalOf } from '../src/spec.ts';
import { loadQuotes, type Quote } from '../src/market.ts';
import { agentSignal, book, chainNote, decide, newId, settle, type HiredAgent, type Order, type Signal, type SkipWhy } from '../src/runner.ts';
import type { Asset } from '../src/intent.ts';
import type { Address } from 'viem';
import { executeTrade, forOwner, stopOut, vaultLook, type CreatorRef, type ExecConfig, type TradeResult } from './executor.ts';
import type { AutoStore } from './autoStore.ts';

export const TICK_MS = 5 * 60_000;
const ASSET_OF: Record<string, Asset> = { WHSK: 'HSK', WETH: 'ETH', WBTC: 'BTC' };
const nameOf = (h: HiredAgent) => (h.source.type === 'market' ? `${h.source.base} ${h.source.rule}` : `${h.asset} plan`);

/** Everything the runner reaches outside itself, so a test can stand in for the chain and the market. */
export interface Deps {
  status(owner: string): Promise<{ configured: boolean; paused?: boolean; maxTradeUsdt?: string; maxDailyUsdt?: string; holdings?: { symbol: string; amount: string; stopDue?: boolean }[] }>;
  signal(h: HiredAgent): Promise<Signal | undefined>;
  trade(owner: string, req: { asset: Asset; side: 'buy' | 'sell'; amount: number; note: string; creator?: CreatorRef; agent?: string }): Promise<TradeResult>;
  stop(owner: string, asset: Asset): Promise<{ ok: true; txHash: string; explorerUrl: string; amountOut: string } | { ok: false; reason: string }>;
}

/**
 * What the runner did at its last look at each owner and each auto agent, kept in memory for the status endpoint:
 * so an owner (and a judge) can see that it is alive, when it looks next, what each agent decided and why, and any
 * error in plain words. Nothing here is secret and none of it is stored.
 */
export type AgentCheck =
  | { at: number; k: 'paused'; why?: 'moved' }
  | { at: number; k: 'vaultPaused' | 'noRule' }
  | { at: number; k: 'noSignal'; error: string }
  | { at: number; k: 'idle'; signal: Signal }
  | { at: number; k: 'skip'; signal: Signal; why: SkipWhy }
  | { at: number; k: 'order'; signal: Signal; side: 'buy' | 'sell'; amount: number; ok: boolean; tx?: string; error?: string };
export interface RunnerState {
  every: number; startedAt: number; passes: number;
  /** The last finished pass: when it began and how long it took. `runningSince`: a pass is under way since then. */
  lastPassAt?: number; lastPassMs?: number; runningSince?: number; nextAt?: number; passError?: string;
  owners: Map<string, { at: number; error?: string }>;
  agents: Map<string, AgentCheck>;
}
export const newRunnerState = (every = TICK_MS, now = Date.now()): RunnerState => ({ every, startedAt: now, passes: 0, owners: new Map(), agents: new Map() });
/** An error in one short line: the chain library's messages go on for pages (the node's address, the whole request). */
const msg = (e: unknown) => String((e as { shortMessage?: unknown } | null)?.shortMessage ?? (e instanceof Error ? e.message : e)).split('\n')[0].slice(0, 200);

/** Why an agent cannot be put on auto for this vault, or nothing when it can. */
export function autoBlock(v: { configured: boolean }): 'noVault' | undefined {
  return v.configured ? undefined : 'noVault';
}

/**
 * A wallet moving to a new vault: every agent of its that works on its own is paused before the new vault is made,
 * and says why. The new vault starts empty, and a buy refused there would leave a signal agent waiting for its signal
 * to flip; the agents' books are about the earlier vault. The owner resumes each one once the money is in. Agents the
 * owner had already paused are left alone. Returns the ids it paused.
 */
export function pauseForMove(store: AutoStore, owner: string, now = Date.now()): string[] {
  const mine = store.list(owner).filter((h) => h.mode === 'auto' && !h.paused);
  for (const h of mine) store.put(owner, { ...h, paused: true, pausedWhy: 'moved', log: [...h.log, { at: now, k: 'paused' }] });
  return mine.map((h) => h.id);
}
/** The new vault was not made after all: the agents pauseForMove paused go back to work as they were. */
export function undoMovePause(store: AutoStore, owner: string, ids: string[]): void {
  for (const h of store.list(owner)) {
    if (!ids.includes(h.id) || h.pausedWhy !== 'moved') continue;
    const back: HiredAgent = { ...h, paused: false, log: h.log.at(-1)?.k === 'paused' ? h.log.slice(0, -1) : h.log };
    delete back.pausedWhy;
    store.put(owner, back);
  }
}

/** One pass over every owner. Returns what happened, for the log. */
export async function tick(store: AutoStore, deps: Deps, now = Date.now(), state?: RunnerState): Promise<string[]> {
  const out: string[] = [];
  const seen = (id: string, c: AgentCheck) => state?.agents.set(id, c);
  // Every vault is read first, side by side: the reads travel to the node together (a few requests for the whole
  // pass). One owner after another, each waiting on its own reads, made a pass as long as the slowest read times
  // the number of wallets whenever the node was slow to answer.
  const owners = store.owners();
  type Look = { v: Awaited<ReturnType<Deps['status']>> } | { error: string };
  const looks = await Promise.all(owners.map((o): Promise<Look> => deps.status(o).then((v) => ({ v }), (e: unknown) => ({ error: msg(e) }))));
  for (const [i, owner] of owners.entries()) {
    const look = looks[i];
    if ('error' in look) { out.push(`${owner}: vault not readable (${look.error})`); state?.owners.set(owner.toLowerCase(), { at: now, error: `vault not readable: ${look.error}` }); continue; }
    const v = look.v;
    state?.owners.set(owner.toLowerCase(), { at: now, ...(v.configured ? {} : { error: 'no vault' }) });
    if (!v.configured) continue;

    // A stop-loss that is due, on any coin this vault holds. The sale takes the whole holding, so every auto agent
    // on that coin gets its share of it on its books.
    for (const held of v.holdings ?? []) {
      const asset = ASSET_OF[held.symbol];
      if (!held.stopDue || !asset) continue;
      const r = await deps.stop(owner, asset);
      out.push(`${owner}: stop-loss on ${held.symbol}: ${r.ok ? r.txHash : r.reason}`);
      if (!r.ok) continue;
      const mine = store.list(owner).filter((h) => h.asset === asset && book(h).qty > 0);
      const total = mine.reduce((sum, h) => sum + book(h).qty, 0);
      for (const h of mine) {
        const qty = book(h).qty;
        const o: Order = { id: newId(), at: now, side: 'sell', qty, why: { k: 'stop', pct: 0, key: `vault-stop:${now}` } };
        const usd = total > 0 ? (Number(r.amountOut) * qty) / total : 0;
        const sold = settle({ ...h, log: [...h.log, { at: now, k: 'asked', order: o }] }, o, { ok: true, amountIn: String(qty), amountOut: String(usd), txHash: r.txHash, explorerUrl: r.explorerUrl }, now);
        // A stop that is followed by buying straight back in is no stop. An agent that follows a signal waits for
        // that signal to go off and come on again; one that buys on a schedule is paused until its owner resumes it.
        const position = h.source.type === 'market' && h.source.kind === 'position';
        store.put(owner, position ? { ...sold, declined: 'buy' } : { ...sold, paused: true, log: [...sold.log, { at: now, k: 'paused' }] });
      }
    }

    for (const h of store.list(owner)) {
      if (h.mode !== 'auto') continue;
      if (h.paused) { seen(h.id, { at: now, k: 'paused', ...(h.pausedWhy ? { why: h.pausedWhy } : {}) }); continue; }
      if (v.paused) { seen(h.id, { at: now, k: 'vaultPaused' }); continue; }
      let s: Signal | undefined;
      try { s = await deps.signal(h); } catch (e) { out.push(`${owner}/${h.id}: no signal (${msg(e)})`); seen(h.id, { at: now, k: 'noSignal', error: msg(e) }); continue; }
      if (!s) { seen(h.id, { at: now, k: 'noRule' }); continue; }
      const d = decide({ ...h, pending: undefined }, s, now, { maxTradeUsd: v.maxTradeUsdt !== undefined ? Number(v.maxTradeUsdt) : undefined });
      if (d.type === 'skip') { seen(h.id, { at: now, k: 'skip', signal: s, why: d.why }); store.put(owner, { ...h, lastRunAt: now, log: [...h.log, { at: now, k: 'skipped', why: d.why }] }); continue; }
      if (d.type === 'idle') { seen(h.id, { at: now, k: 'idle', signal: s }); if (d.clearDeclined) store.put(owner, { ...h, declined: undefined }); continue; }
      if (d.type !== 'order') continue;
      const o: Order = { ...d.order, id: newId(), at: now };
      // Never ask the vault to sell more of a coin than it holds (the owner may have withdrawn some).
      const inVault = Number((v.holdings ?? []).find((x) => ASSET_OF[x.symbol] === h.asset)?.amount ?? 0);
      const amount = o.side === 'buy' ? o.usd ?? 0 : Math.min(o.qty ?? 0, inVault);
      const asked: HiredAgent = { ...h, log: [...h.log, { at: now, k: 'asked', order: o }] };
      // A shared agent names its creator (set by the server from its own record when the agent was put on auto).
      const creator = h.shared ? { address: h.shared.creator as Address, feeBps: h.shared.feeBps } : undefined;
      const r: TradeResult = amount > 0 ? await deps.trade(owner, { asset: h.asset, side: o.side, amount, note: chainNote(nameOf(h), o.why, 'auto', o.journal?.hash), creator, agent: h.id }) : { ok: false, reason: 'The vault holds none of this coin.' };
      seen(h.id, { at: now, k: 'order', signal: s, side: o.side, amount, ok: r.ok, ...(r.ok ? { tx: r.txHash } : { error: r.reason }) });
      store.put(owner, settle(asked, o, r, now));
      out.push(`${owner}/${h.id}: ${o.side} ${amount} ${h.asset}: ${r.ok ? r.txHash : r.reason}`);
    }
  }
  // Not one vault could be read: the chain is not answering, and the pass says so instead of looking fine.
  const failed = looks.flatMap((l) => ('error' in l ? [l.error] : []));
  if (owners.length && failed.length === owners.length) throw new Error(`vaults not readable: ${failed[0]}`);
  return out;
}

/* ---------- the real chain and market ---------- */

const cache = new Map<string, { at: number; signal: Signal }>();
/**
 * How long a signal is reused. A made agent or a short-term market agent decides on its own candles (daily, 4-hour or
 * hourly, see madeHistory),
 * so an hourly one is re-read within a few minutes of each candle closing; daily agents keep the ten minutes.
 */
export const signalTtl = (h: Partial<Pick<HiredAgent, 'spec' | 'source'>>) =>
  ({ '1d': 10 * 60_000, '4h': 4 * 60_000, '1h': 2 * 60_000 })[h.spec ? intervalOf(h.spec) : h.source?.type === 'market' ? ruleInterval(h.source.rule) : '1d'];
/** The pool prices agents that follow a plan decide on: read once and shared for half a minute, not once per agent per pass. */
let quotes: { at: number; p: Promise<Quote[]> } | undefined;
const quotesNow = () => (quotes && Date.now() - quotes.at < 30_000 ? quotes : (quotes = { at: Date.now(), p: loadQuotes() })).p;
/**
 * The longest one agent's signal may take. Its sources have their own deadlines; this is the backstop, so that one
 * read that never comes back costs a pass half a minute, not the five minutes an unanswered request is held by default
 * (which made a pass last as long as the interval between passes, so every other one was skipped).
 */
export const SIGNAL_MS = 30_000;
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`${what} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
/** What the agent's rule says right now, from the same scoring the app shows. */
async function liveSignal(h: HiredAgent): Promise<Signal | undefined> {
  if (h.source.type === 'custom') {
    const q = (await quotesNow()).find((x) => x.asset === h.asset);
    return { kind: 'custom', price: q?.pool };
  }
  const id = h.spec ? `made:${JSON.stringify([h.spec.market, intervalOf(h.spec), h.spec.buy, h.spec.sell])}` : h.source.agentId;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < signalTtl(h)) return hit.signal;
  let a;
  if (h.spec) {
    const market = SIGNAL_MARKETS.find((m) => m.symbol === h.spec!.market);
    a = market ? await scoreMadeLive(h.spec, market) : null;
  } else if (h.source.agentId.startsWith('made:')) {
    return undefined;   // a made agent hired before its rule travelled with it: the app has to re-save it
  } else a = await agentById(h.source.agentId);
  if (!a) return undefined;
  // Moa AI is followed only while the server's AI is on and has set a target; otherwise its agents do nothing.
  if (a.ai && a.target === undefined) return undefined;
  const signal: Signal = agentSignal(a);
  // Moa AI's target is read from this server's own record each time (no network), so a new decision is seen at once.
  if (!a.ai) cache.set(id, { at: Date.now(), signal });
  return signal;
}

export function liveDeps(cfg: ExecConfig): Deps {
  const forThe = (owner: string) => forOwner(cfg, owner as Address);
  return {
    status: async (owner) => vaultLook(await forThe(owner)),
    signal: (h) => withDeadline(liveSignal(h), SIGNAL_MS, 'market data'),
    trade: async (owner, req) => executeTrade(await forThe(owner), req),
    stop: async (owner, asset) => stopOut(await forThe(owner), asset),
  };
}

/** How often the runner looks: MOA_AUTO_TICK_MS shortens it for a local trial; never under ten seconds. */
export const runnerEvery = () => Math.max(10_000, Number(process.env.MOA_AUTO_TICK_MS) || TICK_MS);

/** After a pass that ran past its interval the next one still waits this long, so passes never run back to back. */
export const MIN_REST_MS = 15_000;
/** When the next pass starts: `every` after the last one began, or a short rest after it ended if it took longer. */
export const nextPassAt = (began: number, ended: number, every: number) => Math.max(began + every, ended + Math.min(MIN_REST_MS, every));

/**
 * Run a pass soon and then one every five minutes, recording into `state`. Returns a function that stops it.
 * Each pass schedules the next when it ends, so a slow pass delays the next one a little instead of making the
 * runner skip a whole interval (it used to: a tick that found the last pass still running did nothing).
 */
export function startRunner(cfg: ExecConfig, store: AutoStore, state: RunnerState = newRunnerState(runnerEvery()), deps: Deps = liveDeps(cfg)): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const every = state.every;
  const pass = async () => {
    const at = Date.now();
    state.runningSince = at;
    try {
      for (const line of await tick(store, deps, at, state)) console.log(`[moa auto] ${line}`);
      state.passError = undefined;
    } catch (e) { state.passError = msg(e); console.error('[moa auto] pass failed:', msg(e)); } finally {
      const ended = Date.now();
      state.passes++; state.lastPassAt = at; state.lastPassMs = ended - at; state.runningSince = undefined;
      state.nextAt = nextPassAt(at, ended, every);
      if (state.lastPassMs > 60_000) console.error(`[moa auto] the pass took ${Math.round(state.lastPassMs / 1000)} s`);
      if (!stopped) timer = setTimeout(pass, state.nextAt - ended);
    }
  };
  state.nextAt = Date.now() + Math.min(15_000, every);
  timer = setTimeout(pass, Math.min(15_000, every));
  return () => { stopped = true; clearTimeout(timer); };
}
