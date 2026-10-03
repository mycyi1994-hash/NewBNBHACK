/**
 * POST /api/plans (SPEC §8.2, TASKS M2-02/M2-08).
 * - With a judge session: a sandbox plan (≤ the sandbox cap), paused until its first run.
 * - With `owner: "skill"`: a plan for the caller's own wallet and a bearer token, shown once.
 * Tickers must be in the registry; amounts are validated as decimals, never floats.
 */
import { randomUUID } from 'node:crypto';
import { fromUnits, toUnits, VENUE_MIN_USD, type Issuer } from '@yieldvest/core';
import {
  insertJudgePlan,
  insertSkillPlan,
  judgeExposureUsd,
  listInstruments,
  planFromRow,
  readWorkerStatus,
  usdText,
} from '@yieldvest/db';
import { getAddress, isAddressEqual } from 'viem';
import { activeJudgeOf } from '../../../lib/server/auth';
import { judgeRemaining } from '../../../lib/server/judge';
import { AWAITING_DEPOSIT } from '../../../lib/server/report';
import { JudgePlanBody, SkillPlanBody } from '../../../lib/server/schemas';
import { context } from '../../../lib/server/context';
import {
  clientIp,
  guard,
  json,
  parseWith,
  problem,
  rateLimited,
  readJson,
  tooMany,
  unavailable,
} from '../../../lib/server/http';

export const dynamic = 'force-dynamic';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_PER_WALLET = 5;
const MAX_PLANS_PER_CODE_HOUR = 5;
const units = (value: string) => toUnits(value, 18);

async function handlePOST(request: Request): Promise<Response> {
  const { config, db } = context();
  if (!db) return unavailable('no DATABASE_URL');
  const now = new Date();
  const raw = await readJson(request);
  if (raw instanceof Response) return raw;
  const registry = await listInstruments(db);
  const issuersOf = (t: string) =>
    registry.filter((i) => i.ticker === t).map((i) => i.issuer as Issuer);

  if ((raw as { owner?: unknown } | undefined)?.owner === 'skill') {
    if (rateLimited(`skill-plan:${clientIp(request)}`, 5, 60 * 60_000)) return tooMany();
    const body = parseWith(SkillPlanBody, raw);
    if (body instanceof Response) return body;
    if (issuersOf(body.ticker).length === 0)
      return problem(400, 'unknown_ticker', `${body.ticker} is not in the registry`);
    // The user picks the issuer; the plan never falls back to the other one (the official
    // Agentic Wallet skill: "do not default to Ondo. Ask the user which provider they mean").
    if (!issuersOf(body.ticker).includes(body.issuer))
      return problem(
        400,
        'unknown_ticker',
        `${body.ticker} has no ${body.issuer} token in the registry`,
      );
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
    // The house wallet signs for the worker only: a plan for it could claim the house's trades.
    const house = (await readWorkerStatus(db, 'house'))?.value as { address?: unknown } | undefined;
    if (typeof house?.address === 'string' && isAddressEqual(wallet, getAddress(house.address))) {
      return problem(400, 'house_wallet', 'this wallet cannot hold a skill plan');
    }
    const created = await insertSkillPlan(
      db,
      {
        id: `S-${randomUUID()}`,
        walletAddress: wallet,
        mode: body.mode,
        ticker: body.ticker,
        issuerPreference: [body.issuer],
        contributionUsd: body.contributionUsd,
        cadence: body.cadence,
        window: body.window,
        maxPerBuyUsd: body.maxPerBuyUsd,
        maxDailyUsd: body.maxDailyUsd,
        // A skill yield plan reports its deposit (POST /report) before it runs; principal is recorded from it.
        status: body.mode === 'yield' ? 'paused' : 'active',
        ...(body.mode === 'yield' ? { pausedReason: AWAITING_DEPOSIT } : {}),
        nextDueAt: now.toISOString(),
        // The clock /report compares block times with (lib/server/report.ts), not the database's.
        createdAt: now.toISOString(),
      },
      MAX_OPEN_PER_WALLET,
    );
    if (!created) return problem(429, 'too_many_plans', 'five open plans per wallet');
    return json(
      {
        plan: planFromRow(created.plan),
        token: created.token,
        tokenId: created.tokenId,
        note: 'the token is shown once; keep it with the skill',
      },
      201,
    );
  }

  const judge = await activeJudgeOf(request, config, db, now.getTime());
  if (judge?.kind !== 'judge') return problem(401, 'no_session', 'enter a judge code first');
  const body = parseWith(JudgePlanBody, raw ?? {});
  if (body instanceof Response) return body;
  const issuers = issuersOf(body.ticker);
  if (issuers.length === 0)
    return problem(400, 'unknown_ticker', `${body.ticker} is not in the registry`);
  const amount = units(body.amountUsd);
  const cap = String(config.caps.sandboxMaxPerPlanUsd);
  if (amount > units(cap)) return problem(400, 'over_cap', `a trial plan is at most $${cap}`);
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
  const { remainingUsd: remaining, todayUsd } = await judgeRemaining(
    db,
    config,
    judge.codeHash,
    now,
  );
  if (body.mode === 'safe' && units(remaining) < amount) {
    return problem(409, 'code_exhausted', `this code has $${fromUnits(units(remaining), 18)} left`);
  }
  if (body.mode === 'safe' && units(todayUsd) < amount) {
    // The code has it; today's house-wide cap (house plans and every code together) does not.
    return problem(
      409,
      'daily_cap',
      `today's limit across all codes ($${config.caps.dailySpendCapUsd}) leaves $${fromUnits(units(todayUsd), 18)}; this code still has $${fromUnits(units(remaining), 18)}`,
    );
  }
  if (body.mode === 'yield') {
    // The deposit counts towards the code's total like spend (SECURITY.md: one code, one cap).
    const used = units(usdText(await judgeExposureUsd(db, judge.codeHash)));
    const left = used >= units(cap) ? 0n : units(cap) - used;
    if (left < amount) {
      return problem(409, 'code_exhausted', `this code has $${fromUnits(left, 18)} left`);
    }
  }
  const row = await insertJudgePlan(
    db,
    {
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
    },
    MAX_PLANS_PER_CODE_HOUR,
  );
  if (!row) return problem(429, 'too_many_plans', 'five plans per code per hour');
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
