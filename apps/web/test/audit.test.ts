/**
 * The web's audit fixes through the route handlers: reports are checked against the house wallet,
 * the plan's age and one spelling of the hash, and are written once; a skill yield plan's interest
 * is spent once and a redeem is split into interest and principal; /next values only the plan's
 * own vTokens and keeps the cadence; plan limits hold under concurrency; a removed judge code stops
 * working; held plans are not run; a stop is never refused; bodies must be small JSON.
 */
import { randomUUID } from 'node:crypto';
import {
  createDb,
  getPlan,
  judgeCodes,
  recordSigned,
  sha256Hex,
  updatePlan,
  usdText,
  workerStatus,
  writeWorkerStatus,
  type InstrumentRow,
} from '@yieldvest/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as session } from '../app/api/judge/session/route';
import { GET as nextRoute } from '../app/api/plans/[id]/next/route';
import { GET as positionRoute } from '../app/api/plans/[id]/position/route';
import { POST as reportRoute } from '../app/api/plans/[id]/report/route';
import { POST as run } from '../app/api/plans/[id]/run/route';
import { POST as stop } from '../app/api/plans/[id]/stop/route';
import { POST as createPlan } from '../app/api/plans/route';
import { setChainForTests } from '../lib/server/chain';
import { resetContext } from '../lib/server/context';
import { resetJudgeCodeSync } from '../lib/server/judge';
import { webTestUrl } from './db';
import {
  addJudgeCodes,
  call,
  cleanup,
  cookieFrom,
  E18,
  fakeWebChain,
  randomAddress,
  randomHash,
  ROUTER,
  testInstrument,
  TOKENS_PER_USD,
  transferLog,
  USDT,
  writeTape,
} from './harness';

const VTOKEN = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';
const MONDAY_10_ET = '2026-09-28T14:00:00.000Z';

interface Created {
  plan: { id: string };
  token: string;
  tokenId: string;
}
interface Problem {
  error: { code: string; message: string };
}
interface Answer {
  status: string;
  reason?: string;
  txHash?: string;
  decision?: string;
  retryAt?: string;
}

describe.skipIf(!webTestUrl)('web audit fixes', () => {
  const { db, close } = createDb(webTestUrl ?? 'postgres://unused');
  const chain = fakeWebChain();
  const planIds: string[] = [];
  const tokenIds: string[] = [];
  const codes = [`judge-${randomUUID()}`, `judge-${randomUUID()}`, `judge-${randomUUID()}`];
  let instrument: InstrumentRow;

  beforeAll(async () => {
    instrument = await testInstrument(db);
    await addJudgeCodes(db, codes);
    setChainForTests(chain);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    setChainForTests(undefined);
    await db.delete(workerStatus).where(inArray(workerStatus.key, ['venus', 'house']));
    await cleanup(db, { planIds, instrumentIds: [instrument.id], tokenIds, judgeCodes: codes });
    await resetContext();
    await close();
  });

  function at(iso: string) {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });
  }

  async function skillPlan(body: Record<string, unknown> = {}, wallet = randomAddress()) {
    const res = await call<Created>(createPlan, {
      path: '/api/plans',
      body: {
        owner: 'skill',
        walletAddress: wallet,
        ticker: instrument.ticker,
        contributionUsd: '5',
        cadence: 'daily',
        maxPerBuyUsd: '5',
        maxDailyUsd: '10',
        ...body,
      },
    });
    if (res.status === 201) {
      planIds.push(res.body.plan.id);
      tokenIds.push(res.body.tokenId);
    }
    return { res, id: res.body.plan?.id ?? '', token: res.body.token, wallet };
  }

  const report = (id: string, token: string, body: Record<string, unknown>) =>
    call<Answer>(reportRoute, { path: `/api/plans/${id}/report`, id, token, body });
  const next = (id: string, token: string) =>
    call<Answer>(nextRoute, { path: `/api/plans/${id}/next`, id, token });
  const swapLogs = (wallet: string, spent: bigint, tokens: bigint) => [
    transferLog(USDT, wallet, ROUTER, spent),
    transferLog(instrument.address, ROUTER, wallet, tokens),
  ];

  it('refuses the house wallet, its transactions, and anything older than the plan', async () => {
    const house = randomAddress();
    await writeWorkerStatus(db, 'house', { address: house, usdtUnits: '0', bnbWei: '0' });
    const refused = await skillPlan({}, house);
    expect(refused.res.status).toBe(400);
    expect((refused.res.body as unknown as Problem).error.code).toBe('house_wallet');

    const { id, token, wallet } = await skillPlan();
    // A transaction our house outbox signed is the worker's to record, whoever reports it.
    const signed = randomHash();
    await recordSigned(db, {
      planId: id,
      cycleId: null,
      kind: 'swap',
      chainId: 56,
      fromAddress: house,
      nonce: 900_000 + Math.floor(Math.random() * 90_000),
      rawTx: '0x00',
      txHash: signed,
    });
    chain.mine(signed, { status: 'success', from: wallet, logs: swapLogs(wallet, E18, E18) });
    expect(await report(id, token, { kind: 'swap', txHash: signed })).toMatchObject({
      status: 422,
      body: { reason: 'the transaction was sent by the house wallet' },
    });
    // A swap from before the plan existed is not the plan's.
    const old = randomHash();
    chain.mine(old, {
      status: 'success',
      from: wallet,
      logs: swapLogs(wallet, E18, E18),
      timestamp: BigInt(Math.floor(Date.now() / 1000) - 3600),
    });
    expect(await report(id, token, { kind: 'swap', txHash: old })).toMatchObject({
      status: 422,
      body: { reason: 'the transaction is older than the plan' },
    });
  });

  it('records a hash once in any spelling, then keeps the cadence', async () => {
    at(MONDAY_10_ET);
    const { id, token, wallet } = await skillPlan();
    await writeTape(db, instrument, '2026-09-28T13:55:00.000Z');
    const hash = randomHash();
    chain.mine(hash, {
      status: 'success',
      from: wallet,
      logs: swapLogs(wallet, 5n * E18, 5n * TOKENS_PER_USD),
    });
    const upper = `0x${hash.slice(2).toUpperCase()}`;
    const [first, second] = await Promise.all([
      report(id, token, { kind: 'swap', txHash: upper }),
      report(id, token, { kind: 'swap', txHash: hash }),
    ]);
    expect([first.body.status, second.body.status].sort()).toEqual([
      'already_recorded',
      'recorded',
    ]);
    expect(first.body.txHash).toBe(hash);
    // The plan is daily: the next buy waits for tomorrow's open.
    const plan = await getPlan(db, id);
    expect(plan?.nextDueAt).toMatch(/^2026-09-29 13:32/);
    expect((await next(id, token)).body).toMatchObject({
      decision: 'wait',
      reason: 'not_due',
      retryAt: '2026-09-29T13:32:00.000Z',
    });
  });

  it('spends a skill yield plan’s interest once and splits a redeem into interest and principal', async () => {
    at(MONDAY_10_ET);
    await writeWorkerStatus(db, 'venus', { vToken: VTOKEN, investmentId: `venus-${randomUUID()}` });
    const { id, token, wallet } = await skillPlan({ mode: 'yield', contributionUsd: '0' });
    const deposit = randomHash();
    chain.mine(deposit, {
      status: 'success',
      from: wallet,
      logs: [
        transferLog(USDT, wallet, VTOKEN, 100n * E18),
        transferLog(VTOKEN, VTOKEN, wallet, 100_000_000_000n),
      ],
    });
    expect((await report(id, token, { kind: 'deposit', txHash: deposit })).body.status).toBe(
      'recorded',
    );
    // $3 of interest redeemed (3e9 vTokens at $1e-9 each while the position is worth $103).
    const redeem = randomHash();
    chain.mine(redeem, {
      status: 'success',
      from: wallet,
      logs: [
        transferLog(VTOKEN, wallet, VTOKEN, 2_912_621_359n),
        transferLog(USDT, VTOKEN, wallet, 3n * E18),
      ],
    });
    expect((await report(id, token, { kind: 'redeem', txHash: redeem })).body.status).toBe(
      'recorded',
    );
    // USDT that arrived without any vUSDT leaving the wallet is not a redeem of this position.
    const gift = randomHash();
    chain.mine(gift, {
      status: 'success',
      from: wallet,
      logs: [transferLog(USDT, VTOKEN, wallet, 50n * E18)],
    });
    expect(await report(id, token, { kind: 'redeem', txHash: gift })).toMatchObject({
      status: 422,
      body: { reason: 'no vUSDT left the wallet' },
    });
    let row = await getPlan(db, id);
    expect(usdText(row?.harvestedUnspentUsd ?? '')).toBe('3');
    expect(usdText(row?.principalUsd ?? '')).toBe('100');
    // The swap pays with that interest: it is not there to spend a second time.
    const swap = randomHash();
    chain.mine(swap, {
      status: 'success',
      from: wallet,
      logs: swapLogs(wallet, 3n * E18, 3n * TOKENS_PER_USD),
    });
    expect((await report(id, token, { kind: 'swap', txHash: swap })).body.status).toBe('recorded');
    row = await getPlan(db, id);
    expect(usdText(row?.harvestedUnspentUsd ?? '')).toBe('0');
    // Everything out: interest is only what came back above the principal; the plan pauses.
    const exit = randomHash();
    chain.mine(exit, {
      status: 'success',
      from: wallet,
      logs: [
        transferLog(VTOKEN, wallet, VTOKEN, BigInt(row?.vtokenUnits ?? '0')),
        transferLog(USDT, VTOKEN, wallet, 101n * E18),
      ],
    });
    expect((await report(id, token, { kind: 'redeem', txHash: exit })).body.status).toBe(
      'recorded',
    );
    row = await getPlan(db, id);
    expect(row).toMatchObject({ status: 'paused', pausedReason: 'redeemed', vtokenUnits: '0' });
    expect(usdText(row?.principalUsd ?? '')).toBe('0');
    expect(usdText(row?.harvestedUnspentUsd ?? '')).toBe('1');
  });

  it('values only the plan’s own vTokens, never more than the wallet still holds', async () => {
    at('2026-10-05T14:10:00.000Z');
    await writeWorkerStatus(db, 'venus', { vToken: VTOKEN, investmentId: `venus-${randomUUID()}` });
    const { id, token, wallet } = await skillPlan({ mode: 'yield', contributionUsd: '0' });
    const deposit = randomHash();
    chain.mine(deposit, {
      status: 'success',
      from: wallet,
      logs: [
        transferLog(USDT, wallet, VTOKEN, 100n * E18),
        transferLog(VTOKEN, VTOKEN, wallet, 100_000_000_000n),
      ],
    });
    await report(id, token, { kind: 'deposit', txHash: deposit });
    await writeTape(db, instrument, '2026-10-05T14:05:00.000Z');
    chain.rate = 1_030_000_000_000_000_000_000_000_000n; // $103 for the plan's 1e11 vTokens
    // The wallet holds far more vUSDT (other deposits): only the plan's $3 is interest.
    chain.walletVTokens = 10n ** 15n;
    expect((await next(id, token)).body).toMatchObject({ decision: 'buy', spendUsd: '3' });
    // The wallet took some out elsewhere: the plan's position is what is left, under principal.
    chain.walletVTokens = 90_000_000_000n;
    expect((await next(id, token)).body).toMatchObject({
      decision: 'skip',
      why: { key: 'why.skipped.below_min' },
    });
    // A Venus id the skill would put in argv must be a plain id.
    await writeWorkerStatus(db, 'venus', { vToken: VTOKEN, investmentId: 'x; rm -rf ~' });
    expect((await next(id, token)).body).toMatchObject({
      decision: 'wait',
      reason: 'venus_unavailable',
    });
    chain.walletVTokens = 10n ** 30n;
  });

  it('gives a stopping skill yield plan its own position to take out, never the wallet’s whole Venus USDT', async () => {
    at('2026-10-05T14:10:00.000Z');
    await writeWorkerStatus(db, 'venus', { vToken: VTOKEN, investmentId: `venus-${randomUUID()}` });
    const { id, token, wallet } = await skillPlan({ mode: 'yield', contributionUsd: '0' });
    const position = () =>
      call<{
        position: { principalUsd: string; vTokens: string; underlyingUsd: string };
        steps: { id: string; preview?: string[]; run: string[] }[];
      }>(positionRoute, { path: `/api/plans/${id}/position`, id, token });
    // Before the deposit is reported there is nothing of this plan's to take out.
    expect((await position()).body).toMatchObject({
      position: { principalUsd: '0', vTokens: '0', underlyingUsd: '0' },
      steps: [],
    });
    const deposit = randomHash();
    chain.mine(deposit, {
      status: 'success',
      from: wallet,
      logs: [
        transferLog(USDT, wallet, VTOKEN, 100n * E18),
        transferLog(VTOKEN, VTOKEN, wallet, 100_000_000_000n),
      ],
    });
    await report(id, token, { kind: 'deposit', txHash: deposit });
    chain.rate = 1_030_000_000_000_000_000_000_000_000n; // $103 for the plan's 1e11 vTokens
    // The wallet holds far more Venus USDT than this plan put in: only the plan's $103 comes out.
    chain.walletVTokens = 10n ** 15n;
    const own = await position();
    expect(own.status).toBe(200);
    expect(own.body.position).toEqual({
      principalUsd: '100',
      vTokens: '100000000000',
      underlyingUsd: '103',
    });
    const [redeem, ...rest] = own.body.steps;
    expect(rest).toEqual([]);
    expect(redeem?.run).toEqual([
      'baw',
      'defi',
      'redeem',
      '--investmentId',
      expect.stringMatching(/^venus-/) as unknown,
      '--tokenAddress',
      USDT,
      '--amount',
      '103',
      '--json',
    ]);
    expect(redeem?.run).not.toContain('--ratio');
    // The wallet took some out elsewhere: never more than it still holds.
    chain.walletVTokens = 90_000_000_000n;
    expect((await position()).body.position.underlyingUsd).toBe('92.7');
    chain.walletVTokens = 10n ** 30n;
    // A safe plan keeps no position; a stranger's token opens nothing.
    const safe = await skillPlan();
    const notYield = await call<Problem>(positionRoute, {
      path: `/api/plans/${safe.id}/position`,
      id: safe.id,
      token: safe.token,
    });
    expect([notYield.status, notYield.body.error.code]).toEqual([409, 'not_yield']);
    const stranger = await call<Problem>(positionRoute, {
      path: `/api/plans/${id}/position`,
      id,
      token: safe.token,
    });
    expect(stranger.status).toBe(404);
    expect((await call(positionRoute, { path: `/api/plans/${id}/position`, id })).status).toBe(401);
  });

  it('holds the per-code plan limit under concurrent requests, and drops a removed code', async () => {
    const [code = '', removed = ''] = codes;
    const login = async (c: string) =>
      cookieFrom(await call(session, { path: '/api/judge/session', body: { code: c } }));
    const cookie = await login(code);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call<Created>(createPlan, {
          path: '/api/plans',
          cookie,
          body: { ticker: instrument.ticker, mode: 'safe', amountUsd: '1' },
        }),
      ),
    );
    for (const r of results) if (r.status === 201) planIds.push(r.body.plan.id);
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);

    const kept = await login(removed);
    await db
      .update(judgeCodes)
      .set({ disabled: true })
      .where(eq(judgeCodes.codeHash, sha256Hex(removed)));
    resetJudgeCodeSync();
    const after = await call<Problem>(createPlan, {
      path: '/api/plans',
      cookie: kept,
      body: { ticker: instrument.ticker, mode: 'safe', amountUsd: '1' },
    });
    expect([after.status, after.body.error.code]).toEqual([401, 'no_session']);
  });

  it('never runs a held plan, never refuses a stop, and reads only small JSON bodies', async () => {
    const cookie = cookieFrom(
      await call(session, { path: '/api/judge/session', body: { code: codes[2] } }),
    );
    const created = await call<Created>(createPlan, {
      path: '/api/plans',
      cookie,
      body: { ticker: instrument.ticker, mode: 'safe', amountUsd: '1' },
    });
    expect(created.status).toBe(201);
    const id = created.body.plan.id;
    planIds.push(id);
    const runIt = () => call<Problem>(run, { path: `/api/plans/${id}/run`, id, cookie });
    // Ten jobs fill the plan's budget; a stop is still taken, and asking again gets the same one.
    for (let i = 0; i < 10; i++) expect((await runIt()).status).toBe(202);
    expect([(await runIt()).status]).toEqual([429]);
    const stops: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call<{ jobId: string }>(stop, {
        path: `/api/plans/${id}/stop`,
        id,
        cookie,
      });
      expect(res.status).toBe(202);
      stops.push(res.body.jobId);
    }
    expect(new Set(stops).size).toBe(1);
    // A review hold: the web refuses to run it (the worker would too).
    await updatePlan(db, id, { pausedReason: 'needs_review' });
    const held = await runIt();
    expect([held.status, held.body.error.code]).toEqual([409, 'plan_held']);

    // A body that is not declared JSON is refused unread; so is a large one.
    const form = await createPlan(
      new Request('https://yieldvest.test/api/plans', {
        method: 'POST',
        headers: { cookie, 'content-type': 'text/plain', 'x-real-ip': '198.51.100.9' },
        body: JSON.stringify({ ticker: instrument.ticker, mode: 'safe', amountUsd: '1' }),
      }),
    );
    expect(form.status).toBe(415);
    const huge = await call<Problem>(createPlan, {
      path: '/api/plans',
      cookie,
      body: { ticker: instrument.ticker, amountUsd: '1', pad: 'x'.repeat(20_000) },
    });
    expect([huge.status, huge.body.error.code]).toEqual([413, 'too_large']);
    const big = await call<Problem>(createPlan, {
      path: '/api/plans',
      cookie,
      body: { ticker: instrument.ticker, amountUsd: '1'.repeat(40) },
    });
    expect([big.status, big.body.error.code]).toEqual([400, 'bad_request']);
  });
});
