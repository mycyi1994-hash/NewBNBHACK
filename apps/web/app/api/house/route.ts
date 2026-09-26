/**
 * GET /api/house — the two house plans for the Watch screen (SPEC §8.1): principal, interest so
 * far (yield: the plan's vTokens at today's rate minus its principal, read on chain), shares held,
 * the next buy and the last outcome with its reason.
 */
import { fromUnits, toUnits } from '@ijaro/core';
import {
  holdingFromRow,
  isoTime,
  listCycles,
  listHoldings,
  listPlans,
  planFromRow,
  readWorkerStatus,
  usdText,
} from '@ijaro/db';
import { webChain } from '../../../lib/server/chain';
import { context } from '../../../lib/server/context';
import { json, unavailable } from '../../../lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const venus = (await readWorkerStatus(db, 'venus'))?.value as { vToken?: string } | undefined;
  const rows = await listPlans(db, { ownerKind: 'house' });
  const plans = await Promise.all(
    rows.map(async (row) => {
      const plan = planFromRow(row);
      const [holdings, [last]] = await Promise.all([
        listHoldings(db, row.id),
        listCycles(db, { planIds: [row.id], limit: 1 }),
      ]);
      let interest: { state: 'LIVE' | 'UNAVAILABLE'; usd: string | null; reason?: string } = {
        state: 'UNAVAILABLE',
        usd: null,
        reason: 'not a yield plan',
      };
      if (plan.mode === 'yield') {
        const vTokens = BigInt(row.vtokenUnits);
        if (vTokens === 0n) {
          interest = { state: 'UNAVAILABLE', usd: null, reason: 'no principal deposited yet' };
        } else if (!venus?.vToken) {
          interest = { state: 'UNAVAILABLE', usd: null, reason: 'Venus market not verified yet' };
        } else {
          try {
            const position = toUnits(await webChain(config).vTokensUsd(venus.vToken, vTokens), 18);
            const earned = position - toUnits(plan.principalUsd, 18);
            interest = { state: 'LIVE', usd: fromUnits(earned > 0n ? earned : 0n, 18) };
          } catch (error) {
            interest = {
              state: 'UNAVAILABLE',
              usd: null,
              reason:
                error instanceof Error
                  ? (error.message.split('\n')[0] ?? 'rpc error')
                  : 'rpc error',
            };
          }
        }
      }
      return {
        id: plan.id,
        mode: plan.mode,
        ticker: plan.target.type === 'ticker' ? plan.target.ticker : null,
        cadence: plan.cadence,
        window: plan.window,
        contributionUsd: plan.contributionUsd,
        status: plan.status,
        pausedReason: plan.pausedReason ?? null,
        principalUsd: plan.principalUsd,
        harvestedUnspentUsd: usdText(row.harvestedUnspentUsd),
        interest,
        nextDueAt: plan.nextDueAt,
        holdings: holdings.map(holdingFromRow),
        last: last
          ? {
              at: isoTime(last.startedAt),
              state: last.state,
              outcome: last.outcomeKind,
              why: last.whyKey ? { key: last.whyKey, params: last.whyParams } : null,
            }
          : null,
      };
    }),
  );
  return json({ at: new Date().toISOString(), plans });
}
