/**
 * The house interest plan as the Overview and Earn tabs tell it: principal in Venus, the interest in
 * the position now (read on chain by houseView), the interest already redeemed but not yet spent
 * ("carried forward"), what the interest has bought so far, and the way to the next buy. The engine's
 * own arithmetic (decideCycle): available = interest in the position + carried forward; the plan
 * buys once that reaches the minimum buy. Nothing is extrapolated; an unreadable chain says so.
 */
import type { Config } from '@yieldvest/config';
import { fromUnits, toUnits } from '@yieldvest/core';
import type { Db } from '@yieldvest/db';
import { interestStory, type InterestStory } from './activity';
import { houseView, type HousePlan } from './house';

const units = (usd: string) => toUnits(usd, 18);
const decimal = (value: bigint) => fromUnits(value, 18);

export interface InterestNow {
  state: 'LIVE' | 'UNAVAILABLE';
  /** Interest in the Venus position above principal; null when the chain could not be read. */
  inPositionUsd: string | null;
  /** Interest redeemed from Venus and not spent yet (plans.harvested_unspent_usd). */
  carriedUsd: string;
  /** inPosition + carried: what the next cycle can spend. Null when the chain could not be read. */
  availableUsd: string | null;
  asOf: string | null;
  reason: string | null;
}

export interface HouseStory {
  plans: HousePlan[];
  plan: HousePlan | null;
  story: InterestStory | null;
  interest: InterestNow;
  minBuyUsd: string;
  /** spent + available: every dollar of interest so far, when the chain could be read. */
  earnedUsd: string | null;
  /** What is left to the minimum buy (0 once reached), and progress in percent. */
  leftUsd: string | null;
  percent: number | null;
}

export function interestNow(plan: HousePlan | null): InterestNow {
  const carriedUsd = plan?.harvestedUnspentUsd ?? '0';
  if (!plan) {
    return {
      state: 'UNAVAILABLE',
      inPositionUsd: null,
      carriedUsd,
      availableUsd: null,
      asOf: null,
      reason: 'no yield plan',
    };
  }
  if (plan.interest.state !== 'LIVE' || plan.interest.usd === null) {
    return {
      state: 'UNAVAILABLE',
      inPositionUsd: null,
      carriedUsd,
      availableUsd: null,
      asOf: null,
      reason: plan.interest.reason ?? 'interest not readable',
    };
  }
  return {
    state: 'LIVE',
    inPositionUsd: plan.interest.usd,
    carriedUsd,
    availableUsd: decimal(units(plan.interest.usd) + units(carriedUsd)),
    asOf: plan.interest.asOf ?? null,
    reason: null,
  };
}

export async function houseStory(db: Db, config: Config, now = new Date()): Promise<HouseStory> {
  const house = await houseView(db, config, now);
  const plan = house.plans.find((p) => p.mode === 'yield') ?? null;
  const story = plan ? await interestStory(db, plan.id) : null;
  const interest = interestNow(plan);
  const minBuyUsd = house.minBuyUsd;
  const available = interest.availableUsd === null ? null : units(interest.availableUsd);
  const min = units(minBuyUsd);
  return {
    plans: house.plans,
    plan,
    story,
    interest,
    minBuyUsd,
    earnedUsd: available === null || !story ? null : decimal(available + units(story.spentUsd)),
    leftUsd: available === null ? null : decimal(available >= min ? 0n : min - available),
    percent:
      available === null || min <= 0n
        ? null
        : Math.min(100, Number((available * 10_000n) / min) / 100),
  };
}
