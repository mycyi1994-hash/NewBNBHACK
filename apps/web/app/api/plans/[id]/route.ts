/** GET /api/plans/:id — the public plan view (timeline, receipts, holdings, limits, guardian). */
import { getPlan } from '@ijaro/db';
import { context } from '../../../../lib/server/context';
import { json, problem, unavailable } from '../../../../lib/server/http';
import { planView } from '../../../../lib/server/plan-view';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const { id } = await params;
  const row = await getPlan(db, id);
  if (!row) return problem(404, 'not_found', 'no such plan');
  return json(await planView(db, config, row, new Date()));
}
