/**
 * What a judge code may still spend: its own allowance (the sandbox cap across its plans), and
 * what of that the house-wide daily cap lets it spend today. They differ when the house and the
 * other codes used up today's cap: the code is not used up, today is.
 */
import type { Config } from '@yieldvest/config';
import { remainingSpend, syncJudgeCodes, usdText, utcDay, type Db } from '@yieldvest/db';
import { onWorkers } from './runtime';

export async function judgeRemaining(
  db: Db,
  config: Config,
  codeHash: string,
  now: Date,
): Promise<{ capUsd: string; remainingUsd: string; todayUsd: string; dailyCapUsd: string }> {
  const cap = String(config.caps.sandboxMaxPerPlanUsd);
  const dailyCapUsd = String(config.caps.dailySpendCapUsd);
  const scope = (globalDailyUsd: string) =>
    remainingSpend(db, {
      planId: '',
      ownerKind: 'judge',
      ownerRef: codeHash,
      day: utcDay(now),
      caps: { globalDailyUsd, planDailyUsd: cap, judgeTotalUsd: cap },
    });
  const [own, today] = await Promise.all([scope('Infinity'), scope(dailyCapUsd)]);
  return {
    capUsd: cap,
    remainingUsd: usdText(own),
    todayUsd: usdText(today),
    dailyCapUsd,
  };
}

let synced: Promise<number> | undefined;
let syncedCount: number | undefined;

function done(count: number): number {
  syncedCount = count;
  return count;
}

/**
 * Makes judge_codes match JUDGE_CODES once per server instance (hashes only), so a code list
 * changed in the web's env takes effect on the next deploy. An empty list changes nothing — it
 * never disables every code because a variable was left unset. On Workers a pending promise
 * belongs to the request that started it (runtime.ts), so until one sync has finished each request
 * runs its own (it is idempotent) and only the finished count is shared.
 */
export function ensureJudgeCodes(db: Db, config: Config): Promise<number> {
  if (config.judgeCodes.length === 0) return Promise.resolve(0);
  if (syncedCount !== undefined) return Promise.resolve(syncedCount);
  if (onWorkers) return syncJudgeCodes(db, config.judgeCodes).then(done);
  synced ??= syncJudgeCodes(db, config.judgeCodes)
    .then(done)
    .catch((error: unknown) => {
      synced = undefined;
      throw error;
    });
  return synced;
}

/** Tests: forget that the codes were synced. */
export function resetJudgeCodeSync(): void {
  synced = undefined;
  syncedCount = undefined;
}
