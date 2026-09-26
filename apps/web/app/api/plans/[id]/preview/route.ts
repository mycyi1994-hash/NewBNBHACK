/** POST /api/plans/:id/preview — queued for the worker; poll /api/jobs/:jobId (SPEC §8.2). */
import { callerOf, ownedPlan } from '../../../../../lib/server/auth';
import { context } from '../../../../../lib/server/context';
import { guard, problem, unavailable } from '../../../../../lib/server/http';
import { queueJob } from '../../../../../lib/server/jobs';

export const dynamic = 'force-dynamic';

async function handlePOST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const { id } = await params;
  const plan = await ownedPlan(db, await callerOf(request, config, db), id);
  if (plan instanceof Response) return plan;
  // The worker previews what the house wallet would sign; a skill plan asks GET /next instead.
  if (plan.ownerKind === 'skill') {
    return problem(409, 'use_next', 'skill plans are decided by GET /api/plans/{id}/next');
  }
  return queueJob(db, plan.id, 'preview');
}

export const POST = guard('database', handlePOST);
