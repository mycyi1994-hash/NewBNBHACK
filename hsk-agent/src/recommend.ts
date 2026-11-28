// Which agent Moa suggests. A fixed rule, not a model: the AI only passes the coin the user means.
// Research (research/strategy-selection.md, rank-sim.md): with three years of history no picking rule reliably beat
// holding over the next 90 days, so the pick is not a backtest winner. It is the default chosen in advance from the
// literature: the basket (half held, half a slow trend blend) on BTC and ETH, plain daily DCA on HSK.
//  1. Only agents that can trade on HSKSwap (runnable).
//  2. The coin the user is looking at or named; if no runnable agent trades it, BTC's default.
//  3. The default for that coin. If the user already hired it, the next agent in the list order (agents.ts byMerit:
//     default, ahead, calmer, classic; working now first, then the smaller worst drop), within the user's risk level.
//  4. Lab agents (hourly/4-hour and the 7/28/91-day momentum agent) are never recommended.
// "Other agents" are the next ones in the same order, never lab ones.
import { byMerit, defaultRuleFor, tierOf, type Agent, type Risk } from './agents.ts';

export type Level = 'new' | 'some' | 'pro';
export interface Recommendation { pick: Agent; others: Agent[]; scope: 'coin' | 'all'; pool: number }

export const maxRiskFor = (level?: Level | null): Risk => (level === 'new' ? 2 : 3);

export function recommend(agents: Agent[], opts: { coin?: string; level?: Level | null; exclude?: string[] } = {}): Recommendation | null {
  const runnable = agents.filter((a) => a.runnable && tierOf(a) !== 'lab');
  if (!runnable.length) return null;
  const forCoin = opts.coin ? runnable.filter((a) => a.base === opts.coin) : [];
  const scope = forCoin.length ? 'coin' : 'all';
  const coin = forCoin.length ? opts.coin! : 'BTC';
  const pool = runnable.filter((a) => a.base === coin);
  const scoped = pool.length ? pool : runnable;
  const risk = maxRiskFor(opts.level);
  const ranked = [...scoped].sort(byMerit);
  const fits = ranked.filter((a) => a.risk <= risk || a.rule === defaultRuleFor(a.base));
  const order = fits.length ? fits : ranked;
  const pick = order.find((a) => !opts.exclude?.includes(a.id)) ?? order[0];
  return { pick, others: othersFor(pick, order), scope, pool: order.length };
}

/** "Other agents": the next ones in the same order, each with a rule not shown yet, never a lab agent. */
export function othersFor(pick: Agent, ranked: Agent[], n = 3): Agent[] {
  const seen = new Set([pick.rule]);
  const out: Agent[] = [];
  for (const a of ranked) {
    if (a.id === pick.id || seen.has(a.rule) || tierOf(a) === 'lab') continue;
    seen.add(a.rule);
    out.push(a);
    if (out.length === n) break;
  }
  return out;
}

/** Runnable agents for one coin, in the list order (lab agents last). */
export function rankedFor(agents: Agent[], coin?: string): Agent[] {
  return agents.filter((a) => a.runnable && (!coin || a.base === coin)).sort(byMerit);
}

/** The level the user picked in Moa's opening (saved in this browser). */
export function readLevel(): Level | null {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem('moa.level');
    return v === 'new' || v === 'some' || v === 'pro' ? v : null;
  } catch { return null; }
}
