/**
 * POST /api/plans/:id/run {depositUsd?} — Judge Mode "지금 사기" (SPEC §8.2): queued for the
 * worker, which signs; the page polls /api/jobs/:jobId. A yield plan starts with its deposit.
 */
import { toUnits } from '@ijaro/core';
import { usdText } from '@ijaro/db';
import { judgeOf, ownedPlan } from '../../../../../lib/server/auth';
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
  const plan = await ownedPlan(db, judgeOf(request, config), id);
  if (plan instanceof Response) return plan;
  const body = await readBody(request, RunBody, { optional: true });
  if (body instanceof Response) return body;
  if (plan.mode === 'yield' && usdText(plan.principalUsd) === '0') {
    const deposit = body.depositUsd;
    if (!deposit) return problem(400, 'deposit_required', 'a yield plan starts with depositUsd');
    if (toUnits(deposit, 18) > toUnits(String(config.caps.sandboxMaxPerPlanUsd), 18)) {
      return problem(
        400,
        'over_cap',
        `a judge deposit is at most $${config.caps.sandboxMaxPerPlanUsd}`,
      );
    }
    return queueJob(db, plan.id, 'run', { depositUsd: deposit });
  }
  return queueJob(db, plan.id, 'run');
}

export const POST = guard('database', handlePOST);
