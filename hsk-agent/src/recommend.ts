// Which agent Moa suggests. A fixed rule, not a model: the AI only passes the coin the user means.
//  1. Only agents that can trade on HSKSwap (runnable).
//  2. The coin the user is looking at or named; if no runnable agent trades it, all runnable agents.
//  3. Risk within the user's level: "new" keeps risk 1–2, everyone else 1–3.
//  4. Agents working now (holding, or traded in the last 30 days) before ones that have sat in cash; then published
//     classics before indicator rules before Moa's variations (agents.ts TIER); within the same group the smallest
//     worst drop in the backtest wins (ties: higher period return, then id).
//  5. Agents the user already hired are skipped when another fits.
// It never ranks by past return first: the top of many backtests is usually the one that got lucky.
import { byMerit, type Agent, type Risk } from './agents.ts';

export type Level = 'new' | 'some' | 'pro';
export interface Recommendation { pick: Agent; others: Agent[]; scope: 'coin' | 'all'; pool: number }

export const maxRiskFor = (level?: Level | null): Risk => (level === 'new' ? 2 : 3);

const byDrop = byMerit;

export function recommend(agents: Agent[], opts: { coin?: string; level?: Level | null; exclude?: string[] } = {}): Recommendation | null {
  const runnable = agents.filter((a) => a.runnable);
  if (!runnable.length) return null;
  const forCoin = opts.coin ? runnable.filter((a) => a.base === opts.coin) : [];
  const scope = forCoin.length ? 'coin' : 'all';
  const inScope = forCoin.length ? forCoin : runnable;
  const risk = maxRiskFor(opts.level);
  const fits = inScope.filter((a) => a.risk <= risk);
  const ranked = [...(fits.length ? fits : inScope)].sort(byDrop);
  const pick = ranked.find((a) => !opts.exclude?.includes(a.id)) ?? ranked[0];
  return { pick, others: othersFor(pick, ranked), scope, pool: ranked.length };
}

/** "Other agents": the next ones in the same order, each with a rule not shown yet. */
export function othersFor(pick: Agent, ranked: Agent[], n = 3): Agent[] {
  const seen = new Set([pick.rule]);
  const out: Agent[] = [];
  for (const a of ranked) {
    if (a.id === pick.id || seen.has(a.rule)) continue;
    seen.add(a.rule);
    out.push(a);
    if (out.length === n) break;
  }
  return out;
}

/** Runnable agents for one coin, in the recommend order. */
export function rankedFor(agents: Agent[], coin?: string): Agent[] {
  return agents.filter((a) => a.runnable && (!coin || a.base === coin)).sort(byDrop);
}

/** The level the user picked in Moa's opening (saved in this browser). */
export function readLevel(): Level | null {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem('moa.level');
    return v === 'new' || v === 'some' || v === 'pro' ? v : null;
  } catch { return null; }
}
