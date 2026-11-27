// Ready-made liquidity strategies. A strategy only picks the goal, the shape and how far the blocks reach (the same
// distance on both sides); the amount stays the user's. No past or expected returns are shown for them.
import type { Goal, Shape } from './lp.ts';
import { widthFor } from './lpTalk.ts';

export type LpStrategyId = 'slowBuy' | 'dipLadder' | 'crashCatcher' | 'takeProfit' | 'rangeFees' | 'wideGrid';
export interface LpStrategy { id: LpStrategyId; goal: Goal; shape: Exclude<Shape, 'custom'>; reachPct: number }

/** In the order a beginner should see them: buying first, then selling, then both ways. */
export const LP_STRATEGIES: readonly LpStrategy[] = [
  { id: 'slowBuy', goal: 'buy', shape: 'spot', reachPct: 8 },
  { id: 'dipLadder', goal: 'buy', shape: 'bidask', reachPct: 15 },
  { id: 'crashCatcher', goal: 'buy', shape: 'bidask', reachPct: 30 },
  { id: 'takeProfit', goal: 'sell', shape: 'spot', reachPct: 15 },
  { id: 'rangeFees', goal: 'both', shape: 'curve', reachPct: 4 },
  { id: 'wideGrid', goal: 'both', shape: 'spot', reachPct: 20 },
];

/** The plan fields a strategy sets; amounts are left as they are. */
export const strategyPlan = (s: LpStrategy): { goal: Goal; shape: Exclude<Shape, 'custom'>; step: number; perSide: number; perSideUp?: number; reachPct: number } =>
  ({ goal: s.goal, shape: s.shape, reachPct: s.reachPct, ...widthFor(s.reachPct) });
