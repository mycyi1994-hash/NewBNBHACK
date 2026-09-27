/**
 * Plan settings an operator may change (`pnpm plan:set`). The caps are env values from config and
 * never change here (CLAUDE.md rule 5): a plan's own limits only move inside them. Pure, no I/O.
 */
import { toUnits } from './amounts.js';
import type { Cadence, Plan, PlanWindow } from './types.js';

/** Dollars with at most two decimals, like the plan APIs take ("1", "2.50"). */
const USD_AMOUNT = /^\d+(\.\d{1,2})?$/;
const CADENCES: readonly Cadence[] = ['daily', 'weekly', 'once'];
const WINDOWS: readonly PlanWindow[] = ['regular_session', 'anytime'];

export interface PlanSettings {
  contributionUsd: string;
  maxPerBuyUsd: string;
  maxDailyUsd: string;
  cadence: Cadence;
  window: PlanWindow;
}

/** What an operator typed: any subset, not yet validated. */
export type PlanSettingsChange = Partial<Record<keyof PlanSettings, string>>;

export interface PlanLimitCaps {
  minBuyUsd: string;
  /** The per-transaction cap for the plan's owner (the house cap for house plans). */
  maxPerTxUsd: string;
  dailyCapUsd: string;
}

export function planSettings(plan: Plan): PlanSettings {
  return {
    contributionUsd: plan.contributionUsd,
    maxPerBuyUsd: plan.limits.maxPerBuyUsd,
    maxDailyUsd: plan.limits.maxDailyUsd,
    cadence: plan.cadence,
    window: plan.window,
  };
}

const AMOUNT_NAMES = {
  contributionUsd: 'contribution',
  maxPerBuyUsd: 'per buy',
  maxDailyUsd: 'per day',
} as const;

/**
 * Applies `change` to the plan's settings and says what would be wrong with the result: minimum
 * buy ≤ per buy ≤ per-transaction cap, per buy ≤ per day ≤ daily cap, and a safe plan's
 * contribution at least the minimum buy (below it every cycle would skip). Empty = can run.
 */
export function changePlanSettings(
  plan: Plan,
  change: PlanSettingsChange,
  caps: PlanLimitCaps,
): { settings: PlanSettings; problems: string[] } {
  const problems: string[] = [];
  const settings = planSettings(plan);
  for (const key of ['contributionUsd', 'maxPerBuyUsd', 'maxDailyUsd'] as const) {
    const value = change[key];
    if (value === undefined) continue;
    if (USD_AMOUNT.test(value)) settings[key] = value;
    else problems.push(`${AMOUNT_NAMES[key]} must be dollars like 1 or 2.50, not "${value}"`);
  }
  if (change.cadence !== undefined) {
    const cadence = CADENCES.find((c) => c === change.cadence);
    if (cadence) settings.cadence = cadence;
    else problems.push(`cadence must be one of ${CADENCES.join(', ')}`);
  }
  if (change.window !== undefined) {
    const window = WINDOWS.find((w) => w === change.window);
    if (window) settings.window = window;
    else problems.push(`window must be one of ${WINDOWS.join(', ')}`);
  }
  if (problems.length > 0) return { settings, problems };

  const units = (usd: string) => toUnits(usd, 18);
  const perBuy = units(settings.maxPerBuyUsd);
  const perDay = units(settings.maxDailyUsd);
  const minBuy = units(caps.minBuyUsd);
  if (perBuy < minBuy) {
    problems.push(`per buy $${settings.maxPerBuyUsd} is below the minimum buy $${caps.minBuyUsd}`);
  }
  if (perBuy > units(caps.maxPerTxUsd)) {
    problems.push(
      `per buy $${settings.maxPerBuyUsd} is above the per-transaction cap $${caps.maxPerTxUsd}`,
    );
  }
  if (perDay < perBuy) problems.push(`per day $${settings.maxDailyUsd} is below per buy`);
  if (perDay > units(caps.dailyCapUsd)) {
    problems.push(`per day $${settings.maxDailyUsd} is above the daily cap $${caps.dailyCapUsd}`);
  }
  if (plan.mode === 'safe' && units(settings.contributionUsd) < minBuy) {
    problems.push(
      `a safe plan's contribution $${settings.contributionUsd} is below the minimum buy $${caps.minBuyUsd}`,
    );
  }
  return { settings, problems };
}
