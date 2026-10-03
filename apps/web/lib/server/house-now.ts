/**
 * What the agent would do right now for Yieldvest's own fixed-amount plan (DECISIONS D-34, PD-06):
 * the verdict "Would it buy right now?" gives (preflight: decideCycle through nextFor on the
 * worker's latest market recording) for that plan's stock, amount and window. The first screen
 * shows it while no receipt exists, so a first visit sees the agent decide, not an empty panel.
 * Read-only, and a what-if like /check: the plan itself may be paused.
 */
import type { Issuer, Plan } from '@yieldvest/core';
import { listPlans, planFromRow, type Db } from '@yieldvest/db';
import { preflight, type IssuerVerdict, type Preflight } from './preflight';

export interface HouseNow {
  plan: Pick<Plan, 'id' | 'mode' | 'cadence' | 'window' | 'contributionUsd' | 'status'> & {
    ticker: string;
    pausedReason: string | null;
  };
  preflight: Preflight;
  /** The token the plan would take: its first choice that would buy, else its first choice. */
  verdict: IssuerVerdict;
}

/** The house's fixed-amount plan: H-SAFE when it is there, else the first one not stopped. */
export function houseSafePlan(plans: readonly Plan[]): Plan | undefined {
  const safe = plans.filter(
    (p) =>
      p.owner.kind === 'house' &&
      p.mode === 'safe' &&
      p.target.type === 'ticker' &&
      p.status !== 'stopped',
  );
  return safe.find((p) => p.id === 'H-SAFE') ?? safe[0];
}

/** The verdict for one plan; undefined when its stock is not in the registry. */
export async function houseNowFor(
  db: Db,
  plan: Plan,
  minBuyUsd: string,
  now = new Date(),
): Promise<HouseNow | undefined> {
  if (plan.target.type !== 'ticker') return undefined;
  const result = await preflight(
    db,
    { ticker: plan.target.ticker, usd: plan.contributionUsd, window: plan.window },
    minBuyUsd,
    now,
  );
  if (!result) return undefined;
  // decideCycle takes the plan's first-choice token that can buy (ASSET in decide.ts).
  const rank = (issuer: Issuer) => {
    const at = plan.issuerPreference.indexOf(issuer);
    return at < 0 ? plan.issuerPreference.length : at;
  };
  const ordered = [...result.issuers].sort((a, b) => rank(a.issuer) - rank(b.issuer));
  const verdict = ordered.find((v) => v.decision === 'buy') ?? ordered[0];
  if (!verdict) return undefined;
  return {
    plan: {
      id: plan.id,
      mode: plan.mode,
      cadence: plan.cadence,
      window: plan.window,
      contributionUsd: plan.contributionUsd,
      status: plan.status,
      ticker: plan.target.ticker,
      pausedReason: plan.pausedReason ?? null,
    },
    preflight: result,
    verdict,
  };
}

/** The first screen's verdict: the house's fixed-amount plan right now, when there is one. */
export async function houseNow(
  db: Db,
  minBuyUsd: string,
  now = new Date(),
): Promise<HouseNow | undefined> {
  const plan = houseSafePlan((await listPlans(db, { ownerKind: 'house' })).map(planFromRow));
  return plan ? houseNowFor(db, plan, minBuyUsd, now) : undefined;
}
