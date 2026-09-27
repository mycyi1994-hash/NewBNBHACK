/**
 * Judge Mode through the route handlers (SPEC §8.2, TASKS M2-08/M2-12): a code opens a signed
 * session; a sandbox plan is created only within the sandbox cap; runs, previews and stops are
 * queued for the worker (the web never signs) and only for the plan's owner.
 */
import { randomUUID } from 'node:crypto';
import {
  createDb,
  getJob,
  getPlan,
  judgeCodes,
  openCycle,
  reserveSpend,
  sha256Hex,
  utcDay,
  type PlanRow,
} from '@yieldvest/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as getJobRoute } from '../app/api/jobs/[id]/route';
import { POST as session } from '../app/api/judge/session/route';
import { GET as planRoute } from '../app/api/plans/[id]/route';
import { POST as preview } from '../app/api/plans/[id]/preview/route';
import { POST as run } from '../app/api/plans/[id]/run/route';
import { POST as stop } from '../app/api/plans/[id]/stop/route';
import { POST as createPlan } from '../app/api/plans/route';
import { resetContext } from '../lib/server/context';
import { resetJudgeCodeSync } from '../lib/server/judge';
import { SESSION_TTL_MS } from '../lib/server/session';
import { webTestUrl } from './db';
import { addJudgeCodes, call, cleanup, cookieFrom, testInstrument } from './harness';

interface PlanCreated {
  plan: {
    id: string;
    mode: string;
    status: string;
    pausedReason?: string;
    contributionUsd: string;
    limits: { maxPerBuyUsd: string; maxDailyUsd: string };
    expiresAt?: string;
    owner: { kind: string };
  };
  remainingUsd: string;
  depositUsd?: string;
}
interface Queued {
  jobId: string;
  status: string;
  poll: string;
}
interface Problem {
  error: { code: string; message: string };
}

describe.skipIf(!webTestUrl)('Judge Mode routes', () => {
  const { db, close } = createDb(webTestUrl ?? 'postgres://unused');
  const code = `judge-${randomUUID()}`;
  const other = `judge-${randomUUID()}`;
  const spent = `judge-${randomUUID()}`;
  const planIds: string[] = [];
  let ticker = '';
  let instrumentId = '';

  beforeAll(async () => {
    ({ ticker, id: instrumentId } = await testInstrument(db));
    await addJudgeCodes(db, [code, other, spent]);
  });
  afterAll(async () => {
    await cleanup(db, { planIds, instrumentIds: [instrumentId], judgeCodes: [code, other, spent] });
    await resetContext();
    await close();
  });

  async function login(judgeCode = code): Promise<string> {
    const res = await call(session, { path: '/api/judge/session', body: { code: judgeCode } });
    expect(res.status).toBe(200);
    return cookieFrom(res);
  }

  async function newPlan(cookie: string, body: Record<string, unknown>) {
    const res = await call<PlanCreated>(createPlan, { path: '/api/plans', body, cookie });
    if (res.status === 201) planIds.push(res.body.plan.id);
    return res;
  }

  it('refuses a wrong code; a right one gets a signed HttpOnly cookie that holds no code', async () => {
    const wrong = await call<Problem>(session, {
      path: '/api/judge/session',
      body: { code: 'not-a-code' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('bad_code');
    expect(wrong.headers.get('set-cookie')).toBeNull();

    const right = await call(session, { path: '/api/judge/session', body: { code } });
    expect(right.status).toBe(200);
    expect(right.body).toMatchObject({
      ok: true,
      capUsd: '5',
      remainingUsd: '5',
      exhausted: false,
    });
    const header = right.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/^yieldvest_judge=[0-9a-f]{64}\.\d{13}\.[\w-]+; Path=\/; HttpOnly;/);
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(header).toContain('Secure');
    expect(header).not.toContain(code);
    // The cookie carries the code's hash, never the code.
    expect(header).toContain(sha256Hex(code));
    expect(right.headers.get('cache-control')).toBe('no-store');
  });

  it('limits code attempts per address', async () => {
    const ip = '203.0.113.7';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await call(session, { path: '/api/judge/session', body: { code: `guess-${i}` }, ip }))
          .status,
      );
    }
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401));
    expect(statuses[10]).toBe(429);
  });

  it('creates a sandbox plan only with a session, within the cap, for a registered ticker', async () => {
    const cookie = await login();
    const cases: [Record<string, unknown>, string | undefined, number, string][] = [
      [{ ticker, amountUsd: '5' }, undefined, 401, 'no_session'],
      [{ ticker, amountUsd: '5' }, `${cookie.slice(0, -2)}xx`, 401, 'no_session'],
      [{ ticker, amountUsd: '6' }, cookie, 400, 'over_cap'],
      [{ ticker, amountUsd: '0.2' }, cookie, 400, 'below_min'],
      [{ ticker, amountUsd: '5.123' }, cookie, 400, 'bad_request'],
      [{ ticker: 'ZZZZZZ', amountUsd: '5' }, cookie, 400, 'unknown_ticker'],
      [{ ticker, amountUsd: '5', mode: 'margin' }, cookie, 400, 'bad_request'],
    ];
    for (const [body, withCookie, status, errorCode] of cases) {
      const res = await call<Problem>(createPlan, {
        path: '/api/plans',
        body,
        ...(withCookie ? { cookie: withCookie } : {}),
      });
      expect([res.status, res.body.error.code]).toEqual([status, errorCode]);
    }

    const before = Date.now();
    const created = await newPlan(cookie, { ticker: ticker.toLowerCase(), amountUsd: '5' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      plan: {
        mode: 'safe',
        owner: { kind: 'judge' },
        status: 'paused',
        pausedReason: 'awaiting_run',
        contributionUsd: '5',
        limits: { maxPerBuyUsd: '5', maxDailyUsd: '5' },
      },
      remainingUsd: '5',
    });
    expect(created.body.plan.id).toMatch(/^J-[0-9a-f-]{36}$/);
    const expires = Date.parse(created.body.plan.expiresAt ?? '');
    expect(expires - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(expires - before).toBeLessThanOrEqual(7 * 86_400_000 + 60_000);
    // Stored against the code's hash: the plan knows its judge, the code is nowhere.
    expect((await getPlan(db, created.body.plan.id))?.ownerRef).toBe(sha256Hex(code));
  });

  it('queues run, preview and stop for the plan’s owner only; jobs are readable', async () => {
    const cookie = await login();
    const plan = await newPlan(cookie, { ticker, amountUsd: '5' });
    const id = plan.body.plan.id;

    const stranger = await call<Problem>(run, {
      path: `/api/plans/${id}/run`,
      method: 'POST',
      id,
      cookie: await login(other),
    });
    expect([stranger.status, stranger.body.error.code]).toEqual([404, 'not_found']);
    const anonymous = await call<Problem>(run, {
      path: `/api/plans/${id}/run`,
      method: 'POST',
      id,
    });
    expect([anonymous.status, anonymous.body.error.code]).toEqual([401, 'unauthorized']);

    // "지금 사기" posts no body at all.
    const queued = await call<Queued>(run, {
      path: `/api/plans/${id}/run`,
      method: 'POST',
      id,
      cookie,
    });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ status: 'queued', poll: `/api/jobs/${queued.body.jobId}` });
    const job = await call(getJobRoute, {
      path: `/api/jobs/${queued.body.jobId}`,
      id: queued.body.jobId,
    });
    expect(job.body).toMatchObject({
      jobId: queued.body.jobId,
      kind: 'run',
      planId: id,
      status: 'queued',
      result: null,
      finishedAt: null,
    });

    for (const [handler, kind] of [
      [preview, 'preview'],
      [stop, 'stop'],
    ] as const) {
      const res = await call<Queued>(handler, {
        path: `/api/plans/${id}/${kind}`,
        method: 'POST',
        id,
        cookie,
      });
      expect(res.status).toBe(202);
      expect((await getJob(db, res.body.jobId))?.kind).toBe(kind);
    }
    expect((await call(getJobRoute, { path: '/api/jobs/job-nope', id: 'job-nope' })).status).toBe(
      404,
    );
  });

  it('starts a yield plan with a deposit within the cap', async () => {
    const cookie = await login();
    const created = await newPlan(cookie, { ticker, mode: 'yield', amountUsd: '5' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      plan: { mode: 'yield', contributionUsd: '0', status: 'paused' },
      depositUsd: '5',
    });
    const id = created.body.plan.id;
    const post = (body?: unknown) =>
      call<Problem & Queued>(run, {
        path: `/api/plans/${id}/run`,
        method: 'POST',
        id,
        cookie,
        ...(body === undefined ? {} : { body }),
      });

    const missing = await post();
    expect([missing.status, missing.body.error.code]).toEqual([400, 'deposit_required']);
    const over = await post({ depositUsd: '6' });
    expect([over.status, over.body.error.code]).toEqual([400, 'over_cap']);
    const garbled = await post('{"depositUsd":');
    expect([garbled.status, garbled.body.error.code]).toEqual([400, 'bad_json']);
    const huge = await post(JSON.stringify({ depositUsd: '5', pad: 'x'.repeat(20_000) }));
    expect([huge.status, huge.body.error.code]).toEqual([413, 'too_large']);

    const queued = await post({ depositUsd: '5' });
    expect(queued.status).toBe(202);
    expect(await getJob(db, queued.body.jobId)).toMatchObject({
      kind: 'run',
      planId: id,
      payload: { depositUsd: '5' },
    });
  });

  it('refuses a new plan once the code has spent its $5', async () => {
    const cookie = await login(spent);
    const first = await newPlan(cookie, { ticker, amountUsd: '5' });
    const id = first.body.plan.id;
    // The worker reserved and spent the whole $5 for this code's first plan.
    const { cycle } = await openCycle(db, {
      planId: id,
      dueAt: new Date().toISOString(),
      executionMode: 'simulate',
    });
    expect(
      await reserveSpend(db, {
        planId: id,
        ownerKind: 'judge',
        ownerRef: sha256Hex(spent),
        day: utcDay(new Date()),
        caps: { globalDailyUsd: '50', planDailyUsd: '5', judgeTotalUsd: '5' },
        cycleId: cycle.id,
        amountUsd: '5',
      }),
    ).toMatchObject({ ok: true });

    const again = await call<Problem>(createPlan, {
      path: '/api/plans',
      body: { ticker, amountUsd: '2' },
      cookie,
    });
    expect([again.status, again.body.error.code]).toEqual([409, 'code_exhausted']);
    const state = await call(session, { path: '/api/judge/session', body: { code: spent } });
    expect(state.body).toMatchObject({ remainingUsd: '0', exhausted: true });
  });

  it('shows the public plan view with limits and no owner reference', async () => {
    const cookie = await login();
    const created = await newPlan(cookie, { ticker, amountUsd: '4' });
    const id = created.body.plan.id;
    const view = await call(planRoute, { path: `/api/plans/${id}`, id });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      plan: {
        id,
        owner: 'judge',
        mode: 'safe',
        ticker,
        status: 'paused',
        pausedReason: 'awaiting_run',
        wallet: null,
      },
      limits: { perBuyUsd: '4', perDayUsd: '4', remainingTodayUsd: '4', houseDailyCapUsd: '50' },
      cycles: [],
      receipts: [],
      holdings: [],
      guardian: [],
    });
    expect(view.text).not.toContain(sha256Hex(code));
    expect((await call(planRoute, { path: '/api/plans/J-nope', id: 'J-nope' })).status).toBe(404);
  });

  it('caps the work one plan can queue', async () => {
    const cookie = await login();
    const created = await newPlan(cookie, { ticker, amountUsd: '3' });
    const id = created.body.plan.id;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await call(preview, { path: `/api/plans/${id}/preview`, method: 'POST', id, cookie }))
          .status,
      );
    }
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 202));
    expect(statuses[10]).toBe(429);
    const row: PlanRow | undefined = await getPlan(db, id);
    expect(row?.status).toBe('paused');
  });
  // Last in this file: a sync disables every code missing from JUDGE_CODES.
  it('takes JUDGE_CODES from the environment (hashes only); an empty list disables nothing', async () => {
    const fromEnv = `env-${randomUUID()}`;
    const saved = process.env.JUDGE_CODES;
    try {
      // Empty (the test default): the codes added directly above keep working.
      expect((await call(session, { path: '/api/judge/session', body: { code } })).status).toBe(
        200,
      );
      process.env.JUDGE_CODES = fromEnv;
      await resetContext();
      resetJudgeCodeSync();
      const res = await call(session, { path: '/api/judge/session', body: { code: fromEnv } });
      expect(res.status).toBe(200);
      const [row] = await db
        .select()
        .from(judgeCodes)
        .where(eq(judgeCodes.codeHash, sha256Hex(fromEnv)));
      expect(row).toMatchObject({ disabled: false });
      // Codes no longer listed stop working.
      expect((await call(session, { path: '/api/judge/session', body: { code } })).status).toBe(
        401,
      );
      await db.delete(judgeCodes).where(eq(judgeCodes.codeHash, sha256Hex(fromEnv)));
    } finally {
      process.env.JUDGE_CODES = saved;
      await resetContext();
      resetJudgeCodeSync();
    }
  });
});
