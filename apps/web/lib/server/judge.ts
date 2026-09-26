/** What a judge code may still spend (sandbox cap across its plans; house daily cap). */
import type { Config } from '@ijaro/config';
import { remainingSpend, usdText, utcDay, type Db } from '@ijaro/db';

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
