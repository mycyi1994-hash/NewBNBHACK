/**
 * POST /api/plans/:id/report {kind, txHash, orderId?} (skill token) — the wallet reports what it
 * did; the chain decides what is recorded (SPEC §8.2). 202 while the transaction is not mined.
 */
import { instrumentFromRow, listInstruments, planFromRow, readWorkerStatus } from '@ijaro/db';
import { skillOf, ownedPlan } from '../../../../../lib/server/auth';
import { webChain } from '../../../../../lib/server/chain';
import { context } from '../../../../../lib/server/context';
import {
  guard,
  json,
  rateLimited,
  readBody,
  tooMany,
  unavailable,
} from '../../../../../lib/server/http';
import { recordReport } from '../../../../../lib/server/report';
import { ReportRequest } from '../../../../../lib/server/schemas';

export const dynamic = 'force-dynamic';

async function handlePOST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const { id } = await params;
  if (rateLimited(`report:${id}`, 20, 60_000)) return tooMany();
  const row = await ownedPlan(db, await skillOf(request, db), id);
  if (row instanceof Response) return row;
  const body = await readBody(request, ReportRequest);
  if (body instanceof Response) return body;
  const plan = planFromRow(row);
  const ticker = plan.target.type === 'ticker' ? plan.target.ticker : '';
  const venus = (await readWorkerStatus(db, 'venus'))?.value as { vToken?: string } | undefined;
  const result = await recordReport({
    db,
    reader: webChain(config),
    row,
    plan,
    instruments: (await listInstruments(db))
      .filter((i) => i.ticker === ticker)
      .map(instrumentFromRow),
    vToken: venus?.vToken,
    body: { kind: body.kind, txHash: body.txHash as `0x${string}`, orderId: body.orderId },
    now: new Date(),
  });
  const status = result.status === 'pending' ? 202 : result.status === 'rejected' ? 422 : 200;
  return json(result, status);
}

export const POST = guard('database', handlePOST);
