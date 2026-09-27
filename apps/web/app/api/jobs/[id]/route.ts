/** GET /api/jobs/:id — a queued job's state and, when done, the worker's report. */
import { getJob, isoTime } from '@yieldvest/db';
import { context } from '../../../../lib/server/context';
import { guard, json, problem, unavailable } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

async function handleGET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const { id } = await params;
  const job = await getJob(db, id);
  if (!job) return problem(404, 'not_found', 'no such job');
  return json({
    jobId: job.id,
    kind: job.kind,
    planId: job.planId,
    status: job.status,
    result: job.result,
    error: job.error,
    createdAt: isoTime(job.createdAt),
    finishedAt: job.finishedAt ? isoTime(job.finishedAt) : null,
  });
}

export const GET = guard('database', handleGET);
