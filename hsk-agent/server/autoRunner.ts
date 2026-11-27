// The agents on "auto": every few minutes the server asks each one what it wants to do (the same decide() the app
// uses) and, when it wants to trade, sends the order to its owner's vault at once. No model is involved.
// It also carries out any stop-loss that is due on a vault it knows about; the vault decides whether one applies.
// A daily spending limit and a stop-loss on the vault are recommended in the hire sheet and are the owner's choice:
// the agent's own budget is the only cap this runner applies by itself.
import { agentById, ruleInterval, scoreMadeLive, SIGNAL_MARKETS } from '../src/agents.ts';
import { intervalOf } from '../src/spec.ts';
import { loadQuotes } from '../src/market.ts';
import { agentSignal, book, chainNote, decide, newId, settle, type HiredAgent, type Order, type Signal, type SkipWhy } from '../src/runner.ts';
import type { Asset } from '../src/intent.ts';
import type { Address } from 'viem';
import { executeTrade, forOwner, stopOut, vaultStatus, type CreatorRef, type ExecConfig, type TradeResult } from './executor.ts';
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
  | { at: number; k: 'paused' | 'vaultPaused' | 'noRule' }
  | { at: number; k: 'noSignal'; error: string }
  | { at: number; k: 'idle'; signal: Signal }
  | { at: number; k: 'skip'; signal: Signal; why: SkipWhy }
  | { at: number; k: 'order'; signal: Signal; side: 'buy' | 'sell'; amount: number; ok: boolean; tx?: string; error?: string };
export interface RunnerState {
  every: number; startedAt: number; passes: number;
  lastPassAt?: number; lastPassMs?: number; nextAt?: number; passError?: string;
  owners: Map<string, { at: number; error?: string }>;
  agents: Map<string, AgentCheck>;
}
export const newRunnerState = (every = TICK_MS, now = Date.now()): RunnerState => ({ every, startedAt: now, passes: 0, owners: new Map(), agents: new Map() });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why an agent cannot be put on auto for this vault, or nothing when it can. */
export function autoBlock(v: { configured: boolean }): 'noVault' | undefined {
  return v.configured ? undefined : 'noVault';
}

/** One pass over every owner. Returns what happened, for the log. */
export async function tick(store: AutoStore, deps: Deps, now = Date.now(), state?: RunnerState): Promise<string[]> {
  const out: string[] = [];
  const seen = (id: string, c: AgentCheck) => state?.agents.set(id, c);
  for (const owner of store.owners()) {
    let v: Awaited<ReturnType<Deps['status']>>;
    try { v = await deps.status(owner); } catch (e) { out.push(`${owner}: vault not readable (${msg(e)})`); state?.owners.set(owner.toLowerCase(), { at: now, error: `vault not readable: ${msg(e)}` }); continue; }
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
      if (h.paused) { seen(h.id, { at: now, k: 'paused' }); continue; }
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
/** What the agent's rule says right now, from the same scoring the app shows. */
async function liveSignal(h: HiredAgent): Promise<Signal | undefined> {
  if (h.source.type === 'custom') {
    const q = (await loadQuotes()).find((x) => x.asset === h.asset);
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
  const signal: Signal = agentSignal(a);
  cache.set(id, { at: Date.now(), signal });
  return signal;
}

export function liveDeps(cfg: ExecConfig): Deps {
  const forThe = (owner: string) => forOwner(cfg, owner as Address);
  return {
    status: async (owner) => vaultStatus(await forThe(owner)),
    signal: liveSignal,
    trade: async (owner, req) => executeTrade(await forThe(owner), req),
    stop: async (owner, asset) => stopOut(await forThe(owner), asset),
  };
}

/** How often the runner looks: MOA_AUTO_TICK_MS shortens it for a local trial; never under ten seconds. */
export const runnerEvery = () => Math.max(10_000, Number(process.env.MOA_AUTO_TICK_MS) || TICK_MS);

/** Run a pass now and then every five minutes, recording into `state`. Returns a function that stops it. */
export function startRunner(cfg: ExecConfig, store: AutoStore, state: RunnerState = newRunnerState(runnerEvery())): () => void {
  let busy = false;
  const every = state.every;
  const pass = async () => {
    if (busy) return;
    busy = true;
    const at = Date.now();
    try {
      for (const line of await tick(store, liveDeps(cfg), at, state)) console.log(`[moa auto] ${line}`);
      state.passError = undefined;
    } catch (e) { state.passError = msg(e); console.error('[moa auto] pass failed:', msg(e)); } finally {
      busy = false; state.passes++; state.lastPassAt = at; state.lastPassMs = Date.now() - at; state.nextAt = at + every;
    }
  };
  state.nextAt = Date.now() + Math.min(15_000, every);
  const first = setTimeout(pass, Math.min(15_000, every));
  const timer = setInterval(pass, every);
  return () => { clearTimeout(first); clearInterval(timer); };
}
