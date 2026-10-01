/**
 * GET /api/projection?depositUsd=1000&ticker=NVDA (DECISIONS D-31, F3) — what a deposit would earn
 * if today's listed Venus APY held, how many days until that reaches the minimum buy, and about
 * how many shares a month of it buys at today's on-chain price. Each input carries its data
 * state; the rate changes daily, so this is a projection, never a promise.
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
import { interestProjection } from '../../../lib/server/projection';
import { ProjectionQuery, queryOf } from '../../../lib/server/schemas';

export const dynamic = 'force-dynamic';

async function handleGET(request: Request): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  // The same courtesy limit as GET /next and POST /api/mcp: 120 a minute per address.
  if (rateLimited(`projection-ip:${clientIp(request)}`, 120, 60_000)) return tooMany();
  const query = parseWith(ProjectionQuery, queryOf(request));
  if (query instanceof Response) return query;
  if (Number(query.depositUsd) <= 0)
    return problem(400, 'bad_amount', 'depositUsd must be above 0');
  const view = await interestProjection(db, query, String(config.caps.minBuyUsd));
  if (query.ticker && view.price === null) {
    return problem(
      404,
      'unknown_ticker',
      `${query.ticker}${query.issuer ? ` (${query.issuer})` : ''} is not in the registry`,
    );
  }
  return json(view);
}

export const GET = guard('database', handleGET);
