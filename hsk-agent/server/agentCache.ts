// The scored agent lists, computed on the server and kept: the browser gets a market's whole list (and the pool fill
// model it was scored with) in one request instead of ~200 chain reads and ~25 candle requests of its own.
// Each set is refreshed every few minutes in the background and written to disk, so a restarted server answers at
// once with the last list and says how old it is. A set nobody has asked for yet is computed on its first request.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as cex from '../src/cex.ts';
import { collectAgents, fillModelFor, isRunnable, positionAgents, RUNNABLE, SIGNAL_MARKETS, type Agent } from '../src/agents.ts';
import { pack, type AgentSet } from '../src/agentWire.ts';
import type { FillModel } from '../src/fills.ts';

export const AGENTS_EVERY_MS = 5 * 60_000;
/** A key is a market's position agents (`m:BTCUSDT-PERPETUAL`) or a coin's collect agents (`c:BTC`). */
export type SetKey = `m:${string}` | `c:${string}`;
export type Loader = (key: SetKey) => Promise<{ agents: Agent[]; fills: Record<string, FillModel> }>;

/** The real loader: the same scoring code the browser runs, with the pool read once here. */
export const liveLoader: Loader = async (key) => {
  if (key.startsWith('c:')) {
    const asset = key.slice(2);
    if (!isRunnable(asset)) throw new Error(`no collect agents for ${asset}`);
    return { agents: await collectAgents(asset), fills: {} };
  }
  const m = cex.MARKETS.find((x) => x.symbol === key.slice(2));
  if (!m) throw new Error(`unknown market ${key.slice(2)}`);
  const [agents, model] = await Promise.all([positionAgents(m), fillModelFor(m)]);
  return { agents, fills: { [m.symbol]: model } };
};

/** Every set the app lists by default: each market in the agent market, and the collect agents of each pool coin. */
export const DEFAULT_KEYS: SetKey[] = [...SIGNAL_MARKETS.map((m) => `m:${m.symbol}` as SetKey), ...RUNNABLE.map((a) => `c:${a}` as SetKey)];
export const isKey = (k: string): k is SetKey => /^(m:[A-Z0-9-]{3,40}|c:[A-Z]{2,10})$/.test(k);

export interface AgentCache {
  /** The set for a key: the kept one at once (refreshed in the background when older than the interval), or computed now. */
  get(key: SetKey): Promise<AgentSet>;
  /** Refresh every default set now and then every `every` ms. Returns a function that stops it. */
  start(): () => void;
}

export function openAgentCache(file?: string, opts: { load?: Loader; every?: number; now?: () => number } = {}): AgentCache {
  const load = opts.load ?? liveLoader, every = opts.every ?? AGENTS_EVERY_MS, now = opts.now ?? Date.now;
  const sets = new Map<string, AgentSet>();
  const running = new Map<string, Promise<AgentSet>>();
  if (file && existsSync(file)) {
    try { for (const s of JSON.parse(readFileSync(file, 'utf8')) as AgentSet[]) if (s && isKey(s.key)) sets.set(s.key, s); } catch { console.error(`[moa] could not read ${file}; scoring agents afresh`); }
  }
  const save = () => {
    if (!file) return;
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify([...sets.values()])); renameSync(`${file}.tmp`, file); } catch (e) { console.error('[moa] agent cache not saved:', e instanceof Error ? e.message : e); }
  };
  const refresh = (key: SetKey): Promise<AgentSet> => {
    const had = running.get(key);
    if (had) return had;
    const job = load(key).then(({ agents, fills }) => {
      const set: AgentSet = { at: now(), key, agents: agents.map(pack), fills };
      sets.set(key, set);
      save();
      return set;
    }).finally(() => running.delete(key));
    running.set(key, job);
    return job;
  };
  return {
    async get(key) {
      const kept = sets.get(key);
      if (kept) { if (now() - kept.at > every) void refresh(key).catch(() => undefined); return kept; }
      return refresh(key);
    },
    start() {
      const pass = async () => { for (const k of DEFAULT_KEYS) await refresh(k).catch((e) => console.error(`[moa] agents ${k}:`, e instanceof Error ? e.message : e)); };
      void pass();
      const t = setInterval(() => void pass(), every);
      return () => clearInterval(t);
    },
  };
}

export const agentCacheFile = (env: Record<string, string | undefined>) => join(env.MOA_DATA_DIR || './data', 'agents-cache.json');
