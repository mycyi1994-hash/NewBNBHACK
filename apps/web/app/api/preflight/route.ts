/**
 * GET /api/preflight?ticker=NVDA&usd=5 (DECISIONS D-31, F1) — would Yieldvest buy this right now?
 * decideCycle runs on the worker's latest tape for a fixed-amount plan that does not exist, once
 * per issuer, and every rule's input is listed against its limit. It creates nothing and hands
 * out no command: a plan is still created with POST /api/plans and decided by its own /next.
 */
import { context } from '../../../lib/server/context';
import {
  clientIp,
  guard,
  json,
  parseWith,
  problem,
  rateLimited,
  tooMany,
  unavailable,
} from '../../../lib/server/http';
import { preflight, preflightAmountProblem } from '../../../lib/server/preflight';
import { PreflightQuery, queryOf } from '../../../lib/server/schemas';

export const dynamic = 'force-dynamic';

async function handleGET(request: Request): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  // The same courtesy limit as GET /next and POST /api/mcp: 120 a minute per address.
  if (rateLimited(`preflight-ip:${clientIp(request)}`, 120, 60_000)) return tooMany();
  const query = parseWith(PreflightQuery, queryOf(request));
  if (query instanceof Response) return query;
  const minBuyUsd = String(config.caps.minBuyUsd);
  const bad = preflightAmountProblem(query.usd, {
    minBuyUsd,
    maxPerTxUsd: String(config.caps.houseMaxPerTxUsd),
  });
  if (bad) return problem(400, 'bad_amount', bad);
  const answer = await preflight(db, query, minBuyUsd);
  if (!answer) {
    return problem(
      404,
      'unknown_ticker',
      `${query.ticker}${query.issuer ? ` (${query.issuer})` : ''} is not in the registry`,
    );
  }
  return json(answer);
}

export const GET = guard('database', handleGET);
