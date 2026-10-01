/**
 * GET /api/compare?ticker=NVDA (DECISIONS D-31, F2) — bStocks against Ondo for one stock from the
 * worker's latest tape run, with its data state. Without a ticker: the tickers in the registry and
 * the issuers that sell each. Read-only, like every GET here.
 */
import { context } from '../../../lib/server/context';
import { compareIssuers, comparableTickers } from '../../../lib/server/compare';
import { guard, json, parseWith, problem, unavailable } from '../../../lib/server/http';
import { CompareQuery, queryOf } from '../../../lib/server/schemas';

export const dynamic = 'force-dynamic';

async function handleGET(request: Request): Promise<Response> {
  const { db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const query = parseWith(CompareQuery, queryOf(request));
  if (query instanceof Response) return query;
  if (query.ticker === undefined) return json({ tickers: await comparableTickers(db) });
  const comparison = await compareIssuers(db, query.ticker);
  if (!comparison) return problem(404, 'unknown_ticker', `${query.ticker} is not in the registry`);
  return json(comparison);
}

export const GET = guard('database', handleGET);
