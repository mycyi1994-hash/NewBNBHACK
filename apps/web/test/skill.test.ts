/**
 * The Wallet Skill's API (mode C, SPEC §8.2, §9; TASKS M2-08) through the route handlers: a plan
 * for the user's own wallet with a token shown once; /next decides with decideCycle from the tape
 * and answers with `baw` argv (never calldata); /report records only what the chain shows.
 */
import { randomUUID } from 'node:crypto';
import { BSC_USDT } from '@ijaro/chain';
import {
  createDb,
  getPlan,
  insertGuardianEvent,
  resolveGuardianEvents,
  sha256Hex,
  skillTokens,
  workerStatus,
  writeWorkerStatus,
  type InstrumentRow,
} from '@ijaro/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as nextRoute } from '../app/api/plans/[id]/next/route';
import { POST as previewRoute } from '../app/api/plans/[id]/preview/route';
import { POST as reportRoute } from '../app/api/plans/[id]/report/route';
import { GET as planRoute } from '../app/api/plans/[id]/route';
import { POST as createPlan } from '../app/api/plans/route';
import { setChainForTests } from '../lib/server/chain';
import { resetContext } from '../lib/server/context';
import type { NextStep } from '../lib/server/next';
import { webTestUrl } from './db';
import {
  call,
  cleanup,
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

const MONDAY_10_ET = '2026-09-28T14:00:00.000Z';
const SATURDAY = '2026-10-03T15:00:00.000Z';
const VTOKEN = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';

interface Created {
  plan: { id: string; status: string; pausedReason?: string; owner: { kind: string } };
  token: string;
  tokenId: string;
}
interface Problem {
  error: { code: string; message: string };
}
interface Next {
  decision: string;
  reason?: string;
  why?: { key: string; params: Record<string, string> };
  retryAt?: string;
  spendUsd?: string;
  steps: NextStep[];
}

describe.skipIf(!webTestUrl)('skill routes (mode C)', () => {
  const { db, close } = createDb(webTestUrl ?? 'postgres://unused');
  const chain = fakeWebChain();
  const planIds: string[] = [];
  const tokenIds: string[] = [];
  let instrument: InstrumentRow;

  beforeAll(async () => {
    instrument = await testInstrument(db);
    setChainForTests(chain);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    setChainForTests(undefined);
    await db.delete(workerStatus).where(eq(workerStatus.key, 'venus'));
    await cleanup(db, { planIds, instrumentIds: [instrument.id], tokenIds });
    await resetContext();
    await close();
  });

  /** Freezes the clock the routes read (Date only; timers stay real for the database driver). */
  function at(iso: string) {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });
  }

  async function skillPlan(body: Record<string, unknown> = {}) {
    const wallet = randomAddress();
    const res = await call<Created>(createPlan, {
      path: '/api/plans',
      body: {
        owner: 'skill',
        walletAddress: wallet.toLowerCase(),
        ticker: instrument.ticker,
        contributionUsd: '5',
        cadence: 'weekly',
        maxPerBuyUsd: '5',
        maxDailyUsd: '10',
        ...body,
      },
    });
    expect(res.status).toBe(201);
    planIds.push(res.body.plan.id);
    tokenIds.push(res.body.tokenId);
    return { id: res.body.plan.id, token: res.body.token, wallet, created: res.body };
  }

  const next = (id: string, token?: string) =>
    call<Next>(nextRoute, { path: `/api/plans/${id}/next`, id, ...(token ? { token } : {}) });
  const report = (id: string, token: string, body: Record<string, unknown>) =>
    call<{ status: string; reason?: string; paused?: string; outcome?: { kind: string } }>(
      reportRoute,
      { path: `/api/plans/${id}/report`, id, token, body },
    );

  it('issues a plan and a token shown once; stores only the token’s hash', async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ walletAddress: '0x1234' }, 'bad_request'],
      [{ maxPerBuyUsd: '30', maxDailyUsd: '30' }, 'bad_limits'],
      [{ maxPerBuyUsd: '5', maxDailyUsd: '4' }, 'bad_limits'],
      [{ maxPerBuyUsd: '0.2', maxDailyUsd: '1' }, 'bad_limits'],
      [{ ticker: 'ZZZZZZ' }, 'unknown_ticker'],
    ];
    for (const [override, errorCode] of bad) {
      const res = await call<Problem>(createPlan, {
        path: '/api/plans',
        body: {
          owner: 'skill',
          walletAddress: randomAddress(),
          ticker: instrument.ticker,
          contributionUsd: '5',
          maxPerBuyUsd: '5',
          maxDailyUsd: '10',
          ...override,
        },
      });
      expect([res.status, res.body.error.code]).toEqual([400, errorCode]);
    }

    const { id, token, wallet, created } = await skillPlan();
    expect(created.plan).toMatchObject({ owner: { kind: 'skill' }, status: 'active' });
    expect(token).toMatch(/^ijr_[A-Za-z0-9_-]{43}$/);
    const [stored] = await db.select().from(skillTokens).where(eq(skillTokens.id, created.tokenId));
    expect(stored).toMatchObject({ tokenHash: sha256Hex(token), walletAddress: wallet });
    expect(JSON.stringify(stored)).not.toContain(token);
    expect((await getPlan(db, id))?.walletAddress).toBe(wallet);
  });

  it('answers /next with baw commands in the regular session — no calldata, no signing', async () => {
    const { id, token } = await skillPlan();
    at(MONDAY_10_ET);
    await writeTape(db, instrument, '2026-09-28T13:55:00.000Z');

    const res = await next(id, token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      decision: 'buy',
      spendUsd: '5',
      interestUsd: null,
      instrument: {
        ticker: instrument.ticker,
        issuer: 'bstocks',
        address: instrument.address,
        decimals: 18,
      },
      estimate: { source: 'tape', tokens: '0.022212154002358265' },
      decidedAt: MONDAY_10_ET,
      expiresAt: '2026-09-28T14:05:00.000Z',
    });
    const [quote, swap, ...rest] = res.body.steps;
    expect(rest).toEqual([]);
    const pair = [
      '--fromToken',
      BSC_USDT,
      '--toToken',
      instrument.address,
      '--binanceChainId',
      '56',
    ];
    expect(quote).toEqual({
      id: 'quote',
      run: [
        'baw',
        'market-order',
        'quote',
        '--fromTokenQty',
        '5',
        ...pair,
        '--slippage',
        '0.5',
        '--json',
      ],
      // The wallet's own quote may come in at most 1 % (the price-impact limit) under the tape.
      acceptMinToCoinAmount: '0.021990032462334682',
    });
    expect(swap).toEqual({
      id: 'swap',
      run: [
        'baw',
        'market-order',
        'swap',
        '--fromTokenQty',
        '5',
        ...pair,
        '--slippage',
        '0.5',
        '--json',
      ],
      confirm: ['baw', 'market-order', 'list', '--orderId', '<data.orderId>', '--json'],
      report: {
        kind: 'swap',
        body: { kind: 'swap', txHash: '<txHash of the FINISHED order>', orderId: '<data.orderId>' },
      },
    });
    expect(res.text).not.toMatch(/"(data|calldata|signature)"\s*:\s*"0x/);

    // The worker previews only what the house wallet would sign; a skill plan uses /next.
    const preview = await call<Problem>(previewRoute, {
      path: `/api/plans/${id}/preview`,
      method: 'POST',
      id,
      token,
    });
    expect([preview.status, preview.body.error.code]).toEqual([409, 'use_next']);

    // Only the plan's own token opens it.
    expect((await next(id)).status).toBe(401);
    const stranger = await skillPlan();
    expect((await next(id, stranger.token)).status).toBe(404);
  });

  it('waits when the market is closed or the tape is old, and skips while the guardian blocks', async () => {
    const { id, token } = await skillPlan();

    at(SATURDAY);
    await writeTape(db, instrument, '2026-10-03T14:55:00.000Z', {
      session: 'weekend',
      stockPrice: null,
    });
    expect((await next(id, token)).body).toMatchObject({
      decision: 'wait',
      why: { key: 'why.deferred.market_closed', params: { open: '2026-10-05T13:32:00.000Z' } },
      retryAt: '2026-10-05T13:32:00.000Z',
      data: { tape: 'LIVE' },
    });

    at('2026-10-05T14:00:00.000Z'); // Monday, but the last tape run is two days old
    expect((await next(id, token)).body).toMatchObject({
      decision: 'wait',
      reason: 'data_stale',
      retryAt: '2026-10-05T14:05:00.000Z',
      data: { tape: 'STALE', sampledAt: '2026-10-03T14:55:00.000Z' },
    });

    await writeTape(db, instrument, '2026-10-05T13:50:00.000Z');
    await insertGuardianEvent(db, {
      rule: 'usdt_depeg',
      action: 'pause_buys',
      planId: null,
      detail: { price: '0.985' },
    });
    try {
      expect((await next(id, token)).body).toMatchObject({
        decision: 'skip',
        why: { key: 'why.skipped.guardian.hold', params: { rule: 'usdt_depeg' } },
      });
    } finally {
      await resolveGuardianEvents(db, 'usdt_depeg', new Date());
    }
    expect((await next(id, token)).body.decision).toBe('buy');
  });

  it('records a mined swap from the plan wallet — and nothing the chain does not show', async () => {
    const { id, token, wallet } = await skillPlan();
    at(MONDAY_10_ET);
    const received = TOKENS_PER_USD * 5n;
    const swapLogs = (spent: bigint, tokens: bigint) => [
      transferLog(USDT, wallet, ROUTER, spent),
      ...(tokens > 0n ? [transferLog(instrument.address, ROUTER, wallet, tokens)] : []),
    ];

    const pending = randomHash();
    expect(await report(id, token, { kind: 'swap', txHash: pending })).toMatchObject({
      status: 202,
      body: { status: 'pending' },
    });

    const reverted = randomHash();
    chain.mine(reverted, { status: 'reverted', from: wallet, logs: [] });
    expect(await report(id, token, { kind: 'swap', txHash: reverted })).toMatchObject({
      status: 422,
      body: { status: 'rejected', reason: 'the transaction reverted' },
    });

    const foreign = randomHash();
    chain.mine(foreign, {
      status: 'success',
      from: randomAddress(),
      logs: swapLogs(5n * E18, received),
    });
    expect(await report(id, token, { kind: 'swap', txHash: foreign })).toMatchObject({
      status: 422,
      body: { reason: 'the transaction was not sent by the plan wallet' },
    });

    const nothingBought = randomHash();
    chain.mine(nothingBought, { status: 'success', from: wallet, logs: swapLogs(5n * E18, 0n) });
    expect(await report(id, token, { kind: 'swap', txHash: nothingBought })).toMatchObject({
      status: 422,
      body: { reason: `no ${instrument.ticker} token reached the wallet` },
    });

    const bought = randomHash();
    chain.mine(bought, { status: 'success', from: wallet, logs: swapLogs(5n * E18, received) });
    const recorded = await report(id, token, { kind: 'swap', txHash: bought, orderId: 'o-1' });
    expect(recorded).toMatchObject({
      status: 200,
      body: {
        status: 'recorded',
        kind: 'swap',
        outcome: { kind: 'BOUGHT' },
        why: { key: 'why.bought.regular' },
      },
    });
    expect(recorded.body.paused).toBeUndefined();
    expect(await report(id, token, { kind: 'swap', txHash: bought })).toMatchObject({
      status: 200,
      body: { status: 'already_recorded' },
    });

    const view = await call(planRoute, { path: `/api/plans/${id}`, id });
    expect(view.body).toMatchObject({
      plan: {
        owner: 'skill',
        status: 'active',
        wallet: `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
      },
      limits: { perBuyUsd: '5', perDayUsd: '10', remainingTodayUsd: '5' },
      receipts: [
        {
          kind: 'swap',
          txHash: bought,
          explorerUrl: `https://bscscan.com/tx/${bought}`,
          broadcastVia: 'user_wallet',
          amounts: { orderId: 'o-1', receivedTokens: received.toString() },
        },
      ],
      holdings: [{ instrumentId: instrument.id, tokens: received.toString(), costUsd: '5' }],
      cycles: [{ state: 'done', outcome: { kind: 'BOUGHT' }, why: { key: 'why.bought.regular' } }],
    });
    expect(view.text).not.toContain(wallet);

    // Spending more than the plan allows still happened on chain: recorded, and the plan pauses.
    const overspent = randomHash();
    chain.mine(overspent, { status: 'success', from: wallet, logs: swapLogs(6n * E18, received) });
    expect(await report(id, token, { kind: 'swap', txHash: overspent })).toMatchObject({
      status: 200,
      body: { status: 'recorded', paused: 'report_over_limit' },
    });
    expect((await next(id, token)).body).toMatchObject({
      decision: 'skip',
      reason: 'plan_paused',
      pausedReason: 'report_over_limit',
    });

    const bad = await call<Problem>(reportRoute, {
      path: `/api/plans/${id}/report`,
      id,
      token,
      body: { kind: 'swap', txHash: '0x1234' },
    });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'bad_request']);
  });

  it('starts a skill yield plan from its reported deposit and redeems only interest', async () => {
    await writeWorkerStatus(db, 'venus', { vToken: VTOKEN, investmentId: `venus-${randomUUID()}` });
    const { id, token, wallet, created } = await skillPlan({
      mode: 'yield',
      contributionUsd: '0',
    });
    expect(created.plan).toMatchObject({ status: 'paused', pausedReason: 'awaiting_deposit' });
    expect((await next(id, token)).body).toMatchObject({ decision: 'skip', reason: 'plan_paused' });

    const deposit = randomHash();
    chain.mine(deposit, {
      status: 'success',
      from: wallet,
      logs: [
        transferLog(USDT, wallet, VTOKEN, 100n * E18),
        transferLog(VTOKEN, VTOKEN, wallet, 100_000_000_000n),
      ],
    });
    expect(await report(id, token, { kind: 'deposit', txHash: deposit })).toMatchObject({
      status: 200,
      body: { status: 'recorded', kind: 'deposit' },
    });
    expect(await getPlan(db, id)).toMatchObject({
      status: 'active',
      pausedReason: null,
      vtokenUnits: '100000000000',
    });

    // After every earlier tape run in this file: the latest run is the one the decision reads.
    at('2026-10-05T14:10:00.000Z');
    await writeTape(db, instrument, '2026-10-05T14:05:00.000Z');
    // The plan's own 1e11 vTokens: $100.10 at this rate, $0.10 of interest (under the minimum).
    chain.rate = 1_001_000_000_000_000_000_000_000_000n;
    expect((await next(id, token)).body).toMatchObject({
      decision: 'skip',
      why: { key: 'why.skipped.below_min' },
    });

    chain.rate = 1_030_000_000_000_000_000_000_000_000n; // $103: $3 of interest
    const buy = await next(id, token);
    expect(buy.body).toMatchObject({ decision: 'buy', spendUsd: '3', interestUsd: '3' });
    expect(buy.body.steps.map((s) => s.id)).toEqual(['redeem', 'quote', 'swap']);
    const redeem = buy.body.steps[0];
    const venusArgs = [
      '--investmentId',
      expect.stringMatching(/^venus-/) as unknown,
      '--tokenAddress',
      BSC_USDT,
      '--amount',
      '3',
    ];
    expect(redeem).toEqual({
      id: 'redeem',
      preview: ['baw', 'defi', 'preview', '--action', 'REDEEM', ...venusArgs, '--json'],
      run: ['baw', 'defi', 'redeem', ...venusArgs, '--json'],
      report: { kind: 'redeem', body: { kind: 'redeem', txHash: '<data.txHash>' } },
    });
  });
});
