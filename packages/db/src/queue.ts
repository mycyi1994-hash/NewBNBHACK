/**
 * The worker's two queues (SPEC §5 v2): `jobs`, work the web asks for (preview, run, stop), and
 * `tx_outbox`, signed transactions recorded before they are broadcast. A job is claimed with
 * FOR UPDATE SKIP LOCKED, so concurrent claimers never take the same one.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import { jobs, txOutbox } from './schema.js';

export type JobRow = typeof jobs.$inferSelect;
export type OutboxRow = typeof txOutbox.$inferSelect;
export type OutboxInsert = typeof txOutbox.$inferInsert;

export async function enqueueJob(
  db: Db,
  job: { id: string; kind: string; planId: string; payload?: Record<string, unknown> },
): Promise<JobRow> {
  const [row] = await db
    .insert(jobs)
    .values({ ...job, payload: job.payload ?? {} })
    .returning();
  if (!row) throw new Error(`job ${job.id} was not inserted`);
  return row;
}

/** Oldest queued job of the given kinds, now 'running', or undefined when there is none. */
export async function claimJob(
  db: Db,
  kinds: readonly string[] = ['preview', 'run', 'stop'],
): Promise<JobRow | undefined> {
  const [row] = await db
    .update(jobs)
    .set({ status: 'running', startedAt: sql`now()`, attempts: sql`${jobs.attempts} + 1` })
    .where(
      eq(
        jobs.id,
        sql`(select id from jobs where status = 'queued' and ${inArray(jobs.kind, [...kinds])} order by created_at, id limit 1 for update skip locked)`,
      ),
    )
    .returning();
  return row;
}

export async function finishJob(
  db: Db,
  id: string,
  outcome:
    { status: 'done'; result: Record<string, unknown> } | { status: 'failed'; error: string },
): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: outcome.status,
      ...(outcome.status === 'done' ? { result: outcome.result } : { error: outcome.error }),
      finishedAt: sql`now()`,
    })
    .where(eq(jobs.id, id));
}

export async function getJob(db: Db, id: string): Promise<JobRow | undefined> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row;
}

/** Jobs left 'running' by a worker that died are queued again (their work is idempotent). */
export async function requeueStaleJobs(db: Db, olderThan: Date): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: 'queued' })
    .where(and(eq(jobs.status, 'running'), sql`${jobs.startedAt} < ${olderThan.toISOString()}`))
    .returning({ id: jobs.id });
  return rows.length;
}

/** Records a signed transaction before it is broadcast; the nonce is unique per sender. */
export async function recordSigned(db: Db, row: Omit<OutboxInsert, 'status'>): Promise<OutboxRow> {
  const [created] = await db
    .insert(txOutbox)
    .values({ ...row, status: 'SIGNED' })
    .returning();
  if (!created) throw new Error(`outbox ${row.txHash} was not inserted`);
  return created;
}

export async function markOutbox(
  db: Db,
  txHash: string,
  patch: Partial<Pick<OutboxInsert, 'status' | 'broadcastVia' | 'error'>> & { attempted?: boolean },
): Promise<void> {
  const { attempted, ...rest } = patch;
  await db
    .update(txOutbox)
    .set({
      ...rest,
      ...(attempted ? { attempts: sql`${txOutbox.attempts} + 1` } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(txOutbox.txHash, txHash));
}

/** SIGNED or PENDING transactions: reconciled at boot before any new cycle opens. */
export async function unsettledOutbox(db: Db): Promise<OutboxRow[]> {
  return db
    .select()
    .from(txOutbox)
    .where(inArray(txOutbox.status, ['SIGNED', 'PENDING']))
    .orderBy(asc(txOutbox.nonce));
}

/** Highest nonce recorded for the sender, or undefined when none. */
export async function lastOutboxNonce(
  db: Db,
  chainId: number,
  fromAddress: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ nonce: txOutbox.nonce })
    .from(txOutbox)
    .where(and(eq(txOutbox.chainId, chainId), eq(txOutbox.fromAddress, fromAddress)))
    .orderBy(desc(txOutbox.nonce))
    .limit(1);
  return row?.nonce;
}
