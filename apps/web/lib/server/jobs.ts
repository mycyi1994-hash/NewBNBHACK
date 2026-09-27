/**
 * Queueing work for the worker (SPEC §5 v2: the web never signs). A plan may have a handful of jobs
 * in flight; beyond that the caller waits — a durable limit, counted in Postgres. A stop is never
 * refused for that: it is answered with the stop already waiting, if there is one.
 */
import { randomUUID } from 'node:crypto';
import { enqueueJob, jobs, type Db } from '@yieldvest/db';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { json, problem } from './http';

const MAX_JOBS_PER_10_MIN = 10;

export async function queueJob(
  db: Db,
  planId: string,
  kind: 'preview' | 'run' | 'stop',
  payload: Record<string, unknown> = {},
): Promise<Response> {
  if (kind === 'stop') {
    const [waiting] = await db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(
        and(
          eq(jobs.planId, planId),
          eq(jobs.kind, 'stop'),
          inArray(jobs.status, ['queued', 'running']),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (waiting) {
      return json(
        { jobId: waiting.id, status: waiting.status, poll: `/api/jobs/${waiting.id}` },
        202,
      );
    }
    const job = await enqueueJob(db, { id: `job-${randomUUID()}`, kind, planId, payload });
    return json({ jobId: job.id, status: job.status, poll: `/api/jobs/${job.id}` }, 202);
  }
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.planId, planId), gte(jobs.createdAt, since)));
  if ((recent?.n ?? 0) >= MAX_JOBS_PER_10_MIN) {
    return problem(
      429,
      'too_many_jobs',
      'this plan has enough work queued; try again in a few minutes',
    );
  }
  const job = await enqueueJob(db, { id: `job-${randomUUID()}`, kind, planId, payload });
  return json({ jobId: job.id, status: job.status, poll: `/api/jobs/${job.id}` }, 202);
}
