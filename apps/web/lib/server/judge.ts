/** What a judge code may still spend (sandbox cap across its plans; house daily cap). */
import type { Config } from '@yieldvest/config';
import { remainingSpend, syncJudgeCodes, usdText, utcDay, type Db } from '@yieldvest/db';

export async function judgeRemaining(
  db: Db,
  config: Config,
  codeHash: string,
  now: Date,
): Promise<{ capUsd: string; remainingUsd: string }> {
  const cap = String(config.caps.sandboxMaxPerPlanUsd);
  const remaining = await remainingSpend(db, {
    planId: '',
    ownerKind: 'judge',
    ownerRef: codeHash,
    day: utcDay(now),
    caps: {
      globalDailyUsd: String(config.caps.dailySpendCapUsd),
      planDailyUsd: cap,
      judgeTotalUsd: cap,
    },
  });
  return { capUsd: cap, remainingUsd: usdText(remaining) };
}

let synced: Promise<number> | undefined;

/**
 * Makes judge_codes match JUDGE_CODES once per server instance (hashes only), so a code list
 * changed in the web's env takes effect on the next deploy. An empty list changes nothing — it
 * never disables every code because a variable was left unset.
 */
export function ensureJudgeCodes(db: Db, config: Config): Promise<number> {
  if (config.judgeCodes.length === 0) return Promise.resolve(0);
  synced ??= syncJudgeCodes(db, config.judgeCodes).catch((error: unknown) => {
    synced = undefined;
    throw error;
  });
  return synced;
}

/** Tests: forget that the codes were synced. */
export function resetJudgeCodeSync(): void {
  synced = undefined;
}
