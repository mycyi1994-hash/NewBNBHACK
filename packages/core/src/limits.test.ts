import { describe, expect, it } from 'vitest';
import { changePlanSettings, planSettings } from './limits.js';
import type { Plan } from './types.js';

const H_SAFE: Plan = {
  id: 'H-SAFE',
  owner: { kind: 'house' },
  mode: 'safe',
  target: { type: 'ticker', ticker: 'NVDA' },
  issuerPreference: ['bstocks', 'ondo'],
  principalUsd: '0',
  contributionUsd: '5',
  cadence: 'daily',
  window: 'regular_session',
  limits: { maxPerBuyUsd: '5', maxDailyUsd: '5' },
  status: 'paused',
  pausedReason: 'awaiting_funding',
  createdAt: '2026-09-24T00:00:00.000Z',
  nextDueAt: '2026-09-24T00:00:00.000Z',
};
const H_YIELD: Plan = {
  ...H_SAFE,
  id: 'H-YIELD',
  mode: 'yield',
  contributionUsd: '0',
  cadence: 'weekly',
};
const CAPS = { minBuyUsd: '0.25', maxPerTxUsd: '25', dailyCapUsd: '50' };

describe('changePlanSettings', () => {
  it('reads the settings of a plan', () => {
    expect(planSettings(H_SAFE)).toEqual({
      contributionUsd: '5',
      maxPerBuyUsd: '5',
      maxDailyUsd: '5',
      cadence: 'daily',
      window: 'regular_session',
    });
  });

  it('applies a change inside the caps (the $1 live test)', () => {
    const change = { contributionUsd: '1', maxPerBuyUsd: '1', maxDailyUsd: '1' };
    expect(changePlanSettings(H_SAFE, change, CAPS)).toEqual({
      settings: { ...planSettings(H_SAFE), ...change },
      problems: [],
    });
    const schedule = { cadence: 'weekly', window: 'anytime' };
    expect(changePlanSettings(H_SAFE, schedule, CAPS)).toEqual({
      settings: { ...planSettings(H_SAFE), cadence: 'weekly', window: 'anytime' },
      problems: [],
    });
  });

  it('keeps unchanged values and accepts the edges of the caps', () => {
    const atCaps = { contributionUsd: '0.25', maxPerBuyUsd: '25', maxDailyUsd: '50' };
    expect(changePlanSettings(H_SAFE, atCaps, CAPS).problems).toEqual([]);
    expect(changePlanSettings(H_SAFE, {}, CAPS)).toEqual({
      settings: planSettings(H_SAFE),
      problems: [],
    });
  });

  it('refuses values that are not dollars, cadences or windows before comparing anything', () => {
    const change = {
      contributionUsd: '1.234',
      maxPerBuyUsd: '-1',
      maxDailyUsd: 'lots',
      cadence: 'hourly',
      window: 'night',
    };
    expect(changePlanSettings(H_SAFE, change, CAPS)).toEqual({
      settings: planSettings(H_SAFE),
      problems: [
        'contribution must be dollars like 1 or 2.50, not "1.234"',
        'per buy must be dollars like 1 or 2.50, not "-1"',
        'per day must be dollars like 1 or 2.50, not "lots"',
        'cadence must be one of daily, weekly, once',
        'window must be one of regular_session, anytime',
      ],
    });
  });

  it('keeps per buy between the minimum and the per-transaction cap', () => {
    expect(changePlanSettings(H_SAFE, { maxPerBuyUsd: '0.2' }, CAPS).problems).toEqual([
      'per buy $0.2 is below the minimum buy $0.25',
    ]);
    expect(
      changePlanSettings(H_SAFE, { maxPerBuyUsd: '26', maxDailyUsd: '30' }, CAPS).problems,
    ).toEqual(['per buy $26 is above the per-transaction cap $25']);
  });

  it('keeps per day between per buy and the daily cap', () => {
    expect(changePlanSettings(H_SAFE, { maxDailyUsd: '4' }, CAPS).problems).toEqual([
      'per day $4 is below per buy',
    ]);
    expect(changePlanSettings(H_SAFE, { maxDailyUsd: '51' }, CAPS).problems).toEqual([
      'per day $51 is above the daily cap $50',
    ]);
  });

  it('needs a safe plan to contribute at least the minimum buy; a yield plan may add nothing', () => {
    expect(changePlanSettings(H_SAFE, { contributionUsd: '0.1' }, CAPS).problems).toEqual([
      "a safe plan's contribution $0.1 is below the minimum buy $0.25",
    ]);
    expect(changePlanSettings(H_YIELD, { contributionUsd: '0' }, CAPS).problems).toEqual([]);
  });
});
