/**
 * POST /api/plans (SPEC §8.2, TASKS M2-02/M2-08).
 * - With a judge session: a sandbox plan (≤ the sandbox cap), paused until its first run.
 * - With `owner: "skill"`: a plan for the caller's own wallet and a bearer token, shown once.
 * Tickers must be in the registry; amounts are validated as decimals, never floats.
 */
import { randomUUID } from 'node:crypto';
import { fromUnits, toUnits, VENUE_MIN_USD, type Issuer } from '@ijaro/core';
import {
  createSkillToken,
  insertPlan,
  isoTime,
  listInstruments,
  listPlans,
  planFromRow,
  remainingSpend,
  utcDay,
} from '@ijaro/db';
import { getAddress } from 'viem';
import { judgeOf } from '../../../lib/server/auth';
import { AWAITING_DEPOSIT } from '../../../lib/server/report';
import { JudgePlanBody, SkillPlanBody } from '../../../lib/server/schemas';
import { context } from '../../../lib/server/context';
import {
  clientIp,
  guard,
  json,
  problem,
  rateLimited,
  readBody,
  tooMany,
  unavailable,
} from '../../../lib/server/http';

export const dynamic = 'force-dynamic';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const units = (value: string) => toUnits(value, 18);

async function handlePOST(request: Request): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const now = new Date();
  const raw = (await request
    .clone()
    .json()
    .catch(() => null)) as { owner?: unknown } | null;
  const registry = await listInstruments(db);
  const issuersOf = (t: string) =>
    registry.filter((i) => i.ticker === t).map((i) => i.issuer as Issuer);

  if (raw?.owner === 'skill') {
    if (rateLimited(`skill-plan:${clientIp(request)}`, 5, 60 * 60_000)) return tooMany();
    const body = await readBody(request, SkillPlanBody);
    if (body instanceof Response) return body;
    if (issuersOf(body.ticker).length === 0)
      return problem(400, 'unknown_ticker', `${body.ticker} is not in the registry`);
    // A per-buy limit under the minimum buy could never run (decideCycle refuses it).
    const min = units(String(config.caps.minBuyUsd));
    const cap = units(String(config.caps.houseMaxPerTxUsd));
    if (
      units(body.maxPerBuyUsd) < min ||
      units(body.maxPerBuyUsd) > cap ||
      units(body.maxDailyUsd) < units(body.maxPerBuyUsd)
    ) {
      return problem(
        400,
        'bad_limits',
        `per buy must be in [${config.caps.minBuyUsd}, ${config.caps.houseMaxPerTxUsd}] and per day at least per buy`,
      );
    }
    const wallet = getAddress(body.walletAddress);
    const open = (await listPlans(db, { ownerKind: 'skill' })).filter(
      (p) => p.walletAddress === wallet && p.status !== 'stopped',
    );
    if (open.length >= 5) return problem(429, 'too_many_plans', 'five open plans per wallet');
    const { id: tokenId, token } = await createSkillToken(db, wallet);
    const row = await insertPlan(db, {
      id: `S-${randomUUID()}`,
      ownerKind: 'skill',
      ownerRef: tokenId,
      walletAddress: wallet,
      mode: body.mode,
      ticker: body.ticker,
      issuerPreference: ['bstocks', 'ondo'],
      contributionUsd: body.contributionUsd,
      cadence: body.cadence,
      window: body.window,
      maxPerBuyUsd: body.maxPerBuyUsd,
      maxDailyUsd: body.maxDailyUsd,
      // A skill yield plan reports its deposit (POST /report) before it runs; principal is recorded from it.
      status: body.mode === 'yield' ? 'paused' : 'active',
      ...(body.mode === 'yield' ? { pausedReason: AWAITING_DEPOSIT } : {}),
      nextDueAt: now.toISOString(),
    });
    return json(
      {
        plan: planFromRow(row),
        token,
        tokenId,
        note: 'the token is shown once; keep it with the skill',
      },
      201,
    );
  }

  const judge = judgeOf(request, config, now.getTime());
  if (!judge || judge.kind !== 'judge')
    return problem(401, 'no_session', 'enter a judge code first');
  const body = await readBody(request, JudgePlanBody);
  if (body instanceof Response) return body;
  const issuers = issuersOf(body.ticker);
  if (issuers.length === 0)
    return problem(400, 'unknown_ticker', `${body.ticker} is not in the registry`);
  const amount = units(body.amountUsd);
  const cap = String(config.caps.sandboxMaxPerPlanUsd);
  if (amount > units(cap)) return problem(400, 'over_cap', `a judge plan is at most $${cap}`);
  if (body.mode === 'safe' && amount < units(String(config.caps.minBuyUsd))) {
    return problem(400, 'below_min', `the smallest buy is $${config.caps.minBuyUsd}`);
  }
  // A ticker only an issuer with a higher minimum sells (AAPL: Ondo only, > $5) cannot be bought here.
  const reachable = issuers.some((issuer) => {
    const min = VENUE_MIN_USD[issuer];
    return min === null || amount >= units(min);
  });
  if (body.mode === 'safe' && !reachable) {
    return problem(
      400,
      'venue_minimum',
      `${body.ticker} is only sold above $${issuers.map((i) => VENUE_MIN_USD[i]).join('/')}`,
    );
  }
  const remaining = await remainingSpend(db, {
    planId: '',
    ownerKind: 'judge',
    ownerRef: judge.codeHash,
    day: utcDay(now),
    caps: {
      globalDailyUsd: String(config.caps.dailySpendCapUsd),
      planDailyUsd: cap,
      judgeTotalUsd: cap,
    },
  });
  if (body.mode === 'safe' && units(remaining) < amount) {
    return problem(409, 'code_exhausted', `this code has $${fromUnits(units(remaining), 18)} left`);
  }
  const recent = (await listPlans(db, { ownerKind: 'judge', ownerRef: judge.codeHash })).filter(
    (p) => now.getTime() - Date.parse(isoTime(p.createdAt)) < 60 * 60_000,
  );
  if (recent.length >= 5) return problem(429, 'too_many_plans', 'five plans per code per hour');
  const row = await insertPlan(db, {
    id: `J-${randomUUID()}`,
    ownerKind: 'judge',
    ownerRef: judge.codeHash,
    mode: body.mode,
    ticker: body.ticker,
    issuerPreference: ['bstocks', 'ondo'],
    contributionUsd: body.mode === 'safe' ? body.amountUsd : '0',
    cadence: body.mode === 'safe' ? 'daily' : 'weekly',
    window: body.window,
    maxPerBuyUsd: body.mode === 'safe' ? body.amountUsd : cap,
    maxDailyUsd: body.mode === 'safe' ? body.amountUsd : cap,
    status: 'paused',
    pausedReason: 'awaiting_run',
    nextDueAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + WEEK_MS).toISOString(),
  });
  return json(
    {
      plan: planFromRow(row),
      ...(body.mode === 'yield' ? { depositUsd: body.amountUsd } : {}),
      remainingUsd: fromUnits(units(remaining), 18),
    },
    201,
  );
}

export const POST = guard('database', handlePOST);
