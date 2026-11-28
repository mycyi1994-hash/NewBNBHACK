// Scored agents as they travel from the server's cache to the browser: the same Agent, with its two curves packed as
// [time, value] pairs (values to 6 significant digits) and its market named by symbol. Packing loses nothing a
// screen shows; every number on a card is computed by the server from the full-precision curve before packing.
import * as cex from './cex.ts';
import type { Agent } from './agents.ts';
import type { FillModel } from './fills.ts';

export type WireAgent = Omit<Agent, 'equity' | 'bench' | 'market'> & { eq: [number, number][]; bn: [number, number][]; marketSymbol?: string };
/** One cached set: the agents of a market or a coin, when they were scored, and the fill model they were scored with. */
export interface AgentSet { at: number; key: string; agents: WireAgent[]; fills: Record<string, FillModel> }

const r6 = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : v);
export function pack(a: Agent): WireAgent {
  const { equity, bench, market, ...rest } = a;
  return { ...rest, eq: equity.map((p) => [p.time, r6(p.value)]), bn: bench.map((p) => [p.time, r6(p.value)]), ...(market ? { marketSymbol: market.symbol } : {}) };
}
export function unpack(w: WireAgent): Agent {
  const { eq, bn, marketSymbol, ...rest } = w;
  const market = marketSymbol ? cex.MARKETS.find((m) => m.symbol === marketSymbol) : undefined;
  return { ...rest, equity: eq.map(([time, value]) => ({ time, value })), bench: bn.map(([time, value]) => ({ time, value })), ...(market ? { market } : {}) } as Agent;
}
