/**
 * Queueing work for the worker (SPEC §5 v2: the web never signs). A plan may have a handful of jobs
 * in flight; beyond that the caller waits — a durable limit, counted in Postgres.
 */
import { randomUUID } from 'node:crypto';
import { enqueueJob, jobs, type Db } from '@ijaro/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { json, problem } from './http';

const MAX_JOBS_PER_10_MIN = 10;

export async function queueJob(
  db: Db,
  planId: string,
  kind: 'preview' | 'run' | 'stop',
  payload: Record<string, unknown> = {},
): Promise<Response> {
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
