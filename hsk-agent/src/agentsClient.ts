// The agent lists the browser shows, from the server's cache when it answers (one request, scored every ~5 minutes,
// with the time it was scored), else scored here as before. The user's own made agents are always scored here: they
// live in this browser. See server/agentCache.ts.
import * as cex from './cex.ts';
import { collectAgents, loadAgents, madeAgents, positionAgents, seedFillModel, type Agent } from './agents.ts';
import type { Asset } from './intent.ts';
import { unpack, type AgentSet } from './agentWire.ts';

/** How long the browser waits for the cache before scoring the list itself. */
export const CACHE_WAIT_MS = 8_000;

/** The cached sets for a query, unpacked, or null when the server cannot give them in time. `at` is the oldest set's time. */
export async function fromCache(query: string, wait = CACHE_WAIT_MS): Promise<{ agents: Agent[]; at: number } | null> {
  try {
    const r = await fetch(`/api/agents?${query}`, { signal: AbortSignal.timeout(wait) });
    if (!r.ok) return null;
    const { sets } = (await r.json()) as { sets: AgentSet[] };
    if (!Array.isArray(sets) || !sets.length) return null;
    for (const s of sets) for (const [symbol, model] of Object.entries(s.fills ?? {})) seedFillModel(symbol, model);
    return { agents: sets.flatMap((s) => s.agents.map(unpack)), at: Math.min(...sets.map((s) => s.at)) };
  } catch { return null; }
}

/** The agents under a chart: the market's own, the user's made ones and, on the HSKSwap tab, the coin's collect agents. */
export async function marketAgents(venue: 'cex' | 'dex', market: cex.Market, asset: Asset): Promise<{ list: Agent[]; at: number }> {
  const keys = [`m:${market.symbol}`, ...(venue === 'dex' ? [`c:${asset}`] : [])].join(',');
  const [cached, made] = await Promise.all([fromCache(`keys=${keys}`), madeAgents(market).catch(() => [] as Agent[])]);
  if (cached) return { list: [...cached.agents, ...made], at: cached.at };
  const [a, c] = await Promise.all([positionAgents(market), venue === 'dex' ? collectAgents(asset) : Promise.resolve([] as Agent[])]);
  return { list: [...a, ...made, ...c], at: Date.now() };
}

/** Every agent in the market: the cache's default sets, or scored here. */
export async function allAgents(): Promise<{ agents: Agent[]; at: number }> {
  const cached = await fromCache('');
  return cached ?? { agents: await loadAgents(), at: Date.now() };
}
