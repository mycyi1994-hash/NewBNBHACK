/**
 * GET /api/wallet?address=0x… (DECISIONS D-32) — a wallet's tokenized stocks in shares, its USDT,
 * its Venus USDT position and the Yieldvest plans that use it, read on chain at one block. Public
 * reads only: nothing is signed or stored. Each call reads the chain, so the limit is tighter
 * than the tape-backed routes: 30 a minute per address.
 */
import { context } from '../../../lib/server/context';
import {
  clientIp,
  guard,
  json,
  parseWith,
  rateLimited,
  tooMany,
  unavailable,
} from '../../../lib/server/http';
import { queryOf, WalletQuery } from '../../../lib/server/schemas';
import { walletView } from '../../../lib/server/wallet';

export const dynamic = 'force-dynamic';

async function handleGET(request: Request): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  if (rateLimited(`wallet-ip:${clientIp(request)}`, 30, 60_000)) return tooMany();
  const query = parseWith(WalletQuery, queryOf(request));
  if (query instanceof Response) return query;
  return json(await walletView(db, config, query.address));
}

export const GET = guard('database', handleGET);
