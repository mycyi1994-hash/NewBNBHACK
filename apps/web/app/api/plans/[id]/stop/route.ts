/** POST /api/plans/:id/stop — queued for the worker; poll /api/jobs/:jobId (SPEC §8.2). */
import { callerOf, ownedPlan } from '../../../../../lib/server/auth';
import { context } from '../../../../../lib/server/context';
import { guard, unavailable } from '../../../../../lib/server/http';
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
  return queueJob(db, plan.id, 'stop');
}

export const POST = guard('database', handlePOST);
