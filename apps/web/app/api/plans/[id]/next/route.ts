/**
 * GET /api/plans/:id/next (skill token) — what the user's wallet should do now, as `baw` commands
 * (SPEC §8.2, §9; TASKS M2-08). Decided by decideCycle from the worker's tape, the wallet's Venus
 * position on chain and the plan's own limits; valid for five minutes.
 */
import {
  getPlan,
  guardianVerdictFor,
  instrumentFromRow,
  listInstruments,
  planFromRow,
  readWorkerStatus,
  remainingSpend,
  usdText,
  utcDay,
} from '@ijaro/db';
import { skillOf, ownedPlan } from '../../../../../lib/server/auth';
import { webChain } from '../../../../../lib/server/chain';
import { context } from '../../../../../lib/server/context';
import {
  guard,
  json,
  problem,
  rateLimited,
  tooMany,
  unavailable,
} from '../../../../../lib/server/http';
import { tapeView } from '../../../../../lib/server/market';
import { nextFor } from '../../../../../lib/server/next';

export const dynamic = 'force-dynamic';

async function handleGET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const { id } = await params;
  if (rateLimited(`next:${id}`, 30, 60_000)) return tooMany();
  const row = await ownedPlan(db, await skillOf(request, db), id);
  if (row instanceof Response) return row;
  const fresh = await getPlan(db, row.id);
  if (!fresh) return problem(404, 'not_found', 'no such plan');
  const plan = planFromRow(fresh);
  if (plan.status !== 'active')
    return json({
      planId: plan.id,
      decision: 'skip',
      reason: `plan_${plan.status}`,
      pausedReason: plan.pausedReason ?? null,
    });
  const now = new Date();
  const ticker = plan.target.type === 'ticker' ? plan.target.ticker : '';
  const instruments = (await listInstruments(db))
    .filter((i) => i.ticker === ticker)
    .map(instrumentFromRow);
  const venus = (await readWorkerStatus(db, 'venus'))?.value as
    { investmentId?: string; vToken?: string } | undefined;
  let position: { underlyingUsd: string; harvestedUnspentUsd: string } | undefined;
  if (plan.mode === 'yield') {
    if (!venus?.vToken || !venus.investmentId || !fresh.walletAddress) {
      return json({
        planId: plan.id,
        decidedAt: now.toISOString(),
        decision: 'wait',
        reason: 'venus_unavailable',
      });
    }
    position = {
      underlyingUsd: await webChain(config).venusPositionUsd(venus.vToken, fresh.walletAddress),
      harvestedUnspentUsd: usdText(fresh.harvestedUnspentUsd),
    };
  }
  const remaining = await remainingSpend(db, {
    planId: plan.id,
    ownerKind: 'skill',
    ownerRef: fresh.ownerRef,
    day: utcDay(now),
    caps: { globalDailyUsd: plan.limits.maxDailyUsd, planDailyUsd: plan.limits.maxDailyUsd },
  });
  const answer = nextFor({
    plan,
    instruments,
    tape: await tapeView(db, now),
    caps: { minBuyUsd: String(config.caps.minBuyUsd), maxPerTxUsd: plan.limits.maxPerBuyUsd },
    dailyRemainingUsd: usdText(remaining),
    dailyLimitUsd: plan.limits.maxDailyUsd,
    ...(position ? { position } : {}),
    ...(venus?.investmentId ? { venus: { investmentId: venus.investmentId } } : {}),
    guardian: await guardianVerdictFor(db, plan.id),
    now,
  });
  return json(answer);
}

export const GET = guard('database', handleGET);
