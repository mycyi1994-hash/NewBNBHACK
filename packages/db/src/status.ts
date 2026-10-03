/**
 * worker_status: the worker's last tick, tape run, house balances (from the chain, and as the Wallet
 * API reports them) and the Venus market it verified (read by the web, which never calls the
 * Binance Web3 API itself).
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import { workerStatus } from './schema.js';

/** `house_index`: the house balances as the Wallet API reports them, beside the RPC read (D-34). */
export type WorkerStatusKey = 'tick' | 'tape' | 'house' | 'house_index' | 'venus';

export async function writeWorkerStatus(
  db: Db,
  key: WorkerStatusKey,
  value: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(workerStatus)
    .values({ key, value })
    .onConflictDoUpdate({ target: workerStatus.key, set: { value, updatedAt: sql`now()` } });
}

export async function readWorkerStatus(
  db: Db,
  key: WorkerStatusKey,
): Promise<{ value: Record<string, unknown>; updatedAt: string } | undefined> {
  const [row] = await db.select().from(workerStatus).where(eq(workerStatus.key, key)).limit(1);
  return row
    ? { value: row.value as Record<string, unknown>, updatedAt: row.updatedAt }
    : undefined;
}
