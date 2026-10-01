/**
 * The worker's two queues (SPEC §5 v2): `jobs`, work the web asks for (preview, run, stop), and
 * `tx_outbox`, signed transactions recorded before they are broadcast. A job is claimed with
 * FOR UPDATE SKIP LOCKED, so concurrent claimers never take the same one.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
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
    // Only a job this worker still holds: a job closed at boot (abandoned) stays closed.
    .where(and(eq(jobs.id, id), eq(jobs.status, 'running')));
}

export async function getJob(db: Db, id: string): Promise<JobRow | undefined> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row;
}

/**
 * Jobs a worker left 'running' when it stopped (it is the only worker, and this runs at boot before
 * it claims anything, so every running job is one of these). They are closed as failed rather than
 * run again: a run may already have broadcast, and the outbox and awaiting-cycle checks finish that
 * on-chain truth by themselves. `started_at` is the database's clock, so the cutoff is too: a
 * worker clock behind the database's would otherwise leave the last job running for good.
 */
export async function abandonRunningJobs(db: Db, reason: string): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: 'failed', error: reason, finishedAt: sql`now()` })
    .where(and(eq(jobs.status, 'running'), sql`${jobs.startedAt} <= now()`))
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

export async function outboxByHash(db: Db, txHash: string): Promise<OutboxRow | undefined> {
  const [row] = await db
    .select()
    .from(txOutbox)
    .where(sql`lower(${txOutbox.txHash}) = lower(${txHash})`)
    .limit(1);
  return row;
}

/** A cycle's signed transactions, oldest first. */
export async function outboxOfCycle(db: Db, cycleId: number): Promise<OutboxRow[]> {
  return db
    .select()
    .from(txOutbox)
    .where(eq(txOutbox.cycleId, cycleId))
    .orderBy(asc(txOutbox.nonce));
}

/**
 * Transactions the worker has not finished with: still out on chain (SIGNED, PENDING), or mined
 * (CONFIRMED) with no receipt yet — their effect on the plan is not applied. `planId` narrows it.
 */
export async function unfinishedTransactions(db: Db, planId?: string): Promise<OutboxRow[]> {
  const rows = await db.execute<{ id: number }>(sql`
    select o.id from tx_outbox o
    left join receipts r on r.tx_hash = lower(o.tx_hash)
    where (o.status in ('SIGNED', 'PENDING') or (o.status = 'CONFIRMED' and r.id is null))
    ${planId === undefined ? sql`` : sql`and o.plan_id = ${planId}`}
    order by o.nonce`);
  if (rows.length === 0) return [];
  return db
    .select()
    .from(txOutbox)
    .where(
      inArray(
        txOutbox.id,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(txOutbox.nonce));
}

/** SIGNED or PENDING transactions: reconciled at boot before any new cycle opens. */
export async function unsettledOutbox(db: Db): Promise<OutboxRow[]> {
  return db
    .select()
    .from(txOutbox)
    .where(inArray(txOutbox.status, ['SIGNED', 'PENDING']))
    .orderBy(asc(txOutbox.nonce));
}

/**
 * Highest nonce the sender used on chain as far as we know: rows that were broadcast (a row
 * refused by every broadcast path never consumed its nonce). Undefined when none.
 */
export async function lastOutboxNonce(
  db: Db,
  chainId: number,
  fromAddress: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ nonce: txOutbox.nonce })
    .from(txOutbox)
    .where(
      and(
        eq(txOutbox.chainId, chainId),
        sql`lower(${txOutbox.fromAddress}) = lower(${fromAddress})`,
        isNotNull(txOutbox.broadcastVia),
      ),
    )
    .orderBy(desc(txOutbox.nonce))
    .limit(1);
  return row?.nonce;
}
