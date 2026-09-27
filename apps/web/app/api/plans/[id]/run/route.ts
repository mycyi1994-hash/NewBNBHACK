/**
 * POST /api/plans/:id/run {depositUsd?} — Judge Mode "Buy now" (SPEC §8.2): queued for the
 * worker, which signs; the page polls /api/jobs/:jobId. A yield plan starts with its deposit.
 * The worker checks everything again; these checks answer at once instead of after a poll.
 */
import { fromUnits, toUnits } from '@yieldvest/core';
import { judgeExposureUsd, usdText } from '@yieldvest/db';
import { activeJudgeOf, ownedPlan } from '../../../../../lib/server/auth';
import { context } from '../../../../../lib/server/context';
import { guard, problem, readBody, unavailable } from '../../../../../lib/server/http';
import { queueJob } from '../../../../../lib/server/jobs';
import { RunBody } from '../../../../../lib/server/schemas';

export const dynamic = 'force-dynamic';

async function handlePOST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const { id } = await params;
  const plan = await ownedPlan(db, await activeJudgeOf(request, config, db), id);
  if (plan instanceof Response) return plan;
  // A plan held by a person or the guardian never buys on a web request; only its first run
  // starts a judge plan.
  if (
    plan.status === 'stopped' ||
    (plan.status === 'paused' && plan.pausedReason !== 'awaiting_run')
  ) {
    return problem(
      409,
      'plan_held',
      `the plan is ${plan.status}${plan.pausedReason ? ` (${plan.pausedReason})` : ''}`,
    );
  }
  const body = await readBody(request, RunBody, { optional: true });
  if (body instanceof Response) return body;
  if (plan.mode === 'yield' && usdText(plan.principalUsd) === '0') {
    const deposit = body.depositUsd;
    if (!deposit) return problem(400, 'deposit_required', 'a yield plan starts with depositUsd');
    const cap = toUnits(String(config.caps.sandboxMaxPerPlanUsd), 18);
    if (toUnits(deposit, 18) > cap) {
      return problem(
        400,
        'over_cap',
        `a judge deposit is at most $${config.caps.sandboxMaxPerPlanUsd}`,
      );
    }
    // One code, one sandbox cap: its spend and the principal its plans hold, together.
    const used = toUnits(usdText(await judgeExposureUsd(db, plan.ownerRef ?? '')), 18);
    const left = used >= cap ? 0n : cap - used;
    if (toUnits(deposit, 18) > left) {
      return problem(409, 'code_exhausted', `this code has $${fromUnits(left, 18)} left`);
    }
    return queueJob(db, plan.id, 'run', { depositUsd: deposit });
  }
  return queueJob(db, plan.id, 'run');
}

export const POST = guard('database', handlePOST);
