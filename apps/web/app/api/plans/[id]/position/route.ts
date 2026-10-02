/**
 * GET /api/plans/:id/position (skill token) — a skill yield plan's own Venus position, read on
 * chain, and the `baw` step that takes exactly that much out (the Wallet Skill's stop flow). The
 * wallet can hold more Venus USDT than this plan's — another plan's principal, or the user's own —
 * so the step names this plan's amount instead of `--ratio 1`. Read-only: the user's wallet signs,
 * after the user says yes, and reports it like any redeem.
 */
import { getPlan, readWorkerStatus, usdText } from '@yieldvest/db';
import { skillOf, ownedPlan } from '../../../../../lib/server/auth';
import { planPositionUsd, webChain } from '../../../../../lib/server/chain';
import { context } from '../../../../../lib/server/context';
import {
  clientIp,
  guard,
  json,
  problem,
  rateLimited,
  tooMany,
  unavailable,
} from '../../../../../lib/server/http';
import { redeemStep, SAFE_ID } from '../../../../../lib/server/next';

export const dynamic = 'force-dynamic';

async function handleGET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const { id } = await params;
  if (rateLimited(`position-ip:${clientIp(request)}`, 60, 60_000)) return tooMany();
  const caller = await skillOf(request, db);
  const row = await ownedPlan(db, caller, id);
  if (row instanceof Response) return row;
  if (rateLimited(`position:${caller?.kind === 'skill' ? caller.token.id : ''}:${id}`, 10, 60_000))
    return tooMany();
  const fresh = await getPlan(db, row.id);
  if (!fresh) return problem(404, 'not_found', 'no such plan');
  if (fresh.mode !== 'yield') {
    return problem(409, 'not_yield', 'only a yield plan keeps a Venus position');
  }
  const asOf = new Date().toISOString();
  const venus = (await readWorkerStatus(db, 'venus'))?.value as
    { investmentId?: string; vToken?: string } | undefined;
  if (
    typeof venus?.vToken !== 'string' ||
    typeof venus.investmentId !== 'string' ||
    !SAFE_ID.test(venus.investmentId)
  ) {
    return unavailable('venus_unavailable');
  }
  let underlyingUsd: string | undefined;
  try {
    // The plan's own vTokens, never more than the wallet still holds, at the market's rate.
    underlyingUsd = await planPositionUsd(webChain(config), venus.vToken, fresh);
  } catch (error) {
    console.error(
      'web: position chain read failed —',
      error instanceof Error ? error.message : error,
    );
    return unavailable('chain_unavailable');
  }
  const position = {
    principalUsd: usdText(fresh.principalUsd),
    vTokens: fresh.vtokenUnits,
    underlyingUsd: underlyingUsd ?? '0',
  };
  if (underlyingUsd === undefined || underlyingUsd === '0') {
    return json({ planId: fresh.id, asOf, position, steps: [] });
  }
  return json({
    planId: fresh.id,
    asOf,
    position,
    steps: [redeemStep(venus.investmentId, underlyingUsd)],
  });
}

export const GET = guard('database', handleGET);
