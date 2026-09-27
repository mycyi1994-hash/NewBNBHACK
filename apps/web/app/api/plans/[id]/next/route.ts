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
import { planPositionUsd, webChain } from '../../../../../lib/server/chain';
import { context } from '../../../../../lib/server/context';
import {
  clientIp,
  guard,
  json,
  problem,
  rateLimited,
  tooMany,
  unavailable,
} from '../../../../../lib/server/http';
import { tapeView } from '../../../../../lib/server/market';
import { NEXT_TTL_MS, nextFor } from '../../../../../lib/server/next';

export const dynamic = 'force-dynamic';

/** The worker's Venus id goes into argv the skill runs: only plain ids, nothing a shell reads. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function handleGET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const { id } = await params;
  // Who asks first, then how often: a stranger's requests never use up the owner's allowance.
  if (rateLimited(`next-ip:${clientIp(request)}`, 120, 60_000)) return tooMany();
  const caller = await skillOf(request, db);
  const row = await ownedPlan(db, caller, id);
  if (row instanceof Response) return row;
  if (rateLimited(`next:${caller?.kind === 'skill' ? caller.token.id : ''}:${id}`, 30, 60_000))
    return tooMany();
  const fresh = await getPlan(db, row.id);
  if (!fresh) return problem(404, 'not_found', 'no such plan');
  const plan = planFromRow(fresh);
  const now = new Date();
  const tape = await tapeView(db, now);
  const base = {
    planId: plan.id,
    decidedAt: now.toISOString(),
    data: { tape: tape.state, sampledAt: tape.sampledAt },
  };
  const waitAgain = new Date(now.getTime() + NEXT_TTL_MS).toISOString();
  if (plan.status !== 'active')
    return json({
      ...base,
      decision: 'skip',
      reason: `plan_${plan.status}`,
      pausedReason: plan.pausedReason ?? null,
    });
  const ticker = plan.target.type === 'ticker' ? plan.target.ticker : '';
  const instruments = (await listInstruments(db))
    .filter((i) => i.ticker === ticker)
    .map(instrumentFromRow);
  const venus = (await readWorkerStatus(db, 'venus'))?.value as
    { investmentId?: string; vToken?: string } | undefined;
  const investmentId =
    typeof venus?.investmentId === 'string' && SAFE_ID.test(venus.investmentId)
      ? venus.investmentId
      : undefined;
  let position: { underlyingUsd: string; harvestedUnspentUsd: string } | undefined;
  if (plan.mode === 'yield') {
    if (!venus?.vToken || !investmentId) {
      return json({ ...base, decision: 'wait', reason: 'venus_unavailable', retryAt: waitAgain });
    }
    let underlyingUsd: string | undefined;
    try {
      underlyingUsd = await planPositionUsd(webChain(config), venus.vToken, fresh);
    } catch (error) {
      console.error(
        'web: next chain read failed —',
        error instanceof Error ? error.message : error,
      );
      return json({ ...base, decision: 'wait', reason: 'chain_unavailable', retryAt: waitAgain });
    }
    if (underlyingUsd === undefined) {
      return json({ ...base, decision: 'skip', reason: 'no_principal' });
    }
    position = { underlyingUsd, harvestedUnspentUsd: usdText(fresh.harvestedUnspentUsd) };
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
    tape,
    caps: { minBuyUsd: String(config.caps.minBuyUsd), maxPerTxUsd: plan.limits.maxPerBuyUsd },
    dailyRemainingUsd: usdText(remaining),
    dailyLimitUsd: plan.limits.maxDailyUsd,
    ...(position ? { position } : {}),
    ...(investmentId ? { venus: { investmentId } } : {}),
    guardian: await guardianVerdictFor(db, plan.id),
    now,
  });
  return json(answer);
}

export const GET = guard('database', handleGET);
