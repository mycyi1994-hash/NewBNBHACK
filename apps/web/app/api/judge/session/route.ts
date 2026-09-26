/**
 * POST /api/judge/session {code} (SPEC §8.2): checks a judge code (by its SHA-256 only) and sets
 * the signed session cookie. The answer says what the code may still spend (UX: "코드 하나로
 * 최대 $5까지", "이 코드는 한도를 다 썼어요").
 */
import { findJudgeCode, remainingSpend, usdText, utcDay } from '@ijaro/db';
import { context } from '../../../../lib/server/context';
import {
  clientIp,
  json,
  problem,
  rateLimited,
  readBody,
  tooMany,
  unavailable,
} from '../../../../lib/server/http';
import { JudgeSessionBody } from '../../../../lib/server/schemas';
import { sessionCookie, signSession, SESSION_TTL_MS } from '../../../../lib/server/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  if (!config.sessionSecret)
    return unavailable('judge sessions are not configured (SESSION_SECRET)');
  if (rateLimited(`session:${clientIp(request)}`, 10, 60_000)) return tooMany();
  const body = await readBody(request, JudgeSessionBody);
  if (body instanceof Response) return body;
  const judge = await findJudgeCode(db, body.code);
  if (!judge) return problem(401, 'bad_code', 'the code does not match');

  const now = Date.now();
  const cap = String(config.caps.sandboxMaxPerPlanUsd);
  const remaining = await remainingSpend(db, {
    planId: '',
    ownerKind: 'judge',
    ownerRef: judge.codeHash,
    day: utcDay(new Date(now)),
    caps: {
      globalDailyUsd: String(config.caps.dailySpendCapUsd),
      planDailyUsd: cap,
      judgeTotalUsd: cap,
    },
  });
  const expiresAt = now + SESSION_TTL_MS;
  // Behind a TLS-terminating proxy the request itself may be plain http.
  const secure =
    new URL(request.url).protocol === 'https:' ||
    request.headers.get('x-forwarded-proto') === 'https' ||
    config.appUrl.startsWith('https:');
  return json(
    {
      ok: true,
      capUsd: cap,
      remainingUsd: usdText(remaining),
      exhausted: Number(remaining) <= 0,
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
