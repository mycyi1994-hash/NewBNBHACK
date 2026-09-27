/**
 * POST /api/judge/session {code} (SPEC §8.2): checks a judge code (by its SHA-256 only) and sets
 * the signed session cookie. The answer says what the code may still spend (UX: "One code
 * covers up to $5", "This code has used its limit").
 */
import { findJudgeCode } from '@yieldvest/db';
import { context } from '../../../../lib/server/context';
import {
  clientIp,
  guard,
  json,
  problem,
  rateLimited,
  readBody,
  tooMany,
  unavailable,
} from '../../../../lib/server/http';
import { ensureJudgeCodes, judgeRemaining } from '../../../../lib/server/judge';
import { JudgeSessionBody } from '../../../../lib/server/schemas';
import { sessionCookie, signSession, SESSION_TTL_MS } from '../../../../lib/server/session';

export const dynamic = 'force-dynamic';

async function handlePOST(request: Request): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  if (!config.sessionSecret)
    return unavailable('judge sessions are not configured (SESSION_SECRET)');
  if (rateLimited(`session:${clientIp(request)}`, 10, 60_000)) return tooMany();
  const body = await readBody(request, JudgeSessionBody);
  if (body instanceof Response) return body;
  await ensureJudgeCodes(db, config);
  const judge = await findJudgeCode(db, body.code);
  if (!judge) return problem(401, 'bad_code', 'the code does not match');

  const now = Date.now();
  const { capUsd, remainingUsd } = await judgeRemaining(db, config, judge.codeHash, new Date(now));
  const expiresAt = now + SESSION_TTL_MS;
  // Behind a TLS-terminating proxy the request itself may be plain http.
  const secure =
    new URL(request.url).protocol === 'https:' ||
    request.headers.get('x-forwarded-proto') === 'https' ||
    config.appUrl.startsWith('https:');
  return json(
    {
      ok: true,
      capUsd,
      remainingUsd,
      exhausted: Number(remainingUsd) <= 0,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    200,
    {
      'Set-Cookie': sessionCookie(
        signSession(config.sessionSecret, judge.codeHash, expiresAt),
        SESSION_TTL_MS,
        secure,
      ),
    },
  );
}

export const POST = guard('database', handlePOST);
