/** Who is calling: a judge (session cookie) or a skill (bearer token), and whose plan it is. */
import { findSkillToken, getPlan, type Db, type PlanRow, type SkillTokenRow } from '@ijaro/db';
import type { Config } from '@ijaro/config';
import { problem } from './http';
import { cookieValue, SESSION_COOKIE, verifySession } from './session';

export type Caller = { kind: 'judge'; codeHash: string } | { kind: 'skill'; token: SkillTokenRow };

export function judgeOf(request: Request, config: Config, nowMs = Date.now()): Caller | undefined {
  const value = cookieValue(request, SESSION_COOKIE);
  if (!value || !config.sessionSecret) return undefined;
  const session = verifySession(config.sessionSecret, value, nowMs);
  return session ? { kind: 'judge', codeHash: session.codeHash } : undefined;
}

export async function skillOf(request: Request, db: Db): Promise<Caller | undefined> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (ijr_[A-Za-z0-9_-]{43})$/.exec(header);
  if (!match?.[1]) return undefined;
  const token = await findSkillToken(db, match[1]);
  return token ? { kind: 'skill', token } : undefined;
}

export async function callerOf(
  request: Request,
  config: Config,
  db: Db,
): Promise<Caller | undefined> {
  return judgeOf(request, config) ?? (await skillOf(request, db));
}

/** The plan when the caller owns it; a response otherwise. */
export async function ownedPlan(
  db: Db,
  caller: Caller | undefined,
  planId: string,
): Promise<PlanRow | Response> {
  if (!caller) return problem(401, 'unauthorized', 'a judge session or a skill token is required');
  const plan = await getPlan(db, planId);
  const owns =
    plan &&
    ((caller.kind === 'judge' && plan.ownerKind === 'judge' && plan.ownerRef === caller.codeHash) ||
      (caller.kind === 'skill' && plan.ownerKind === 'skill' && plan.ownerRef === caller.token.id));
  return owns ? plan : problem(404, 'not_found', 'no such plan for this caller');
}
