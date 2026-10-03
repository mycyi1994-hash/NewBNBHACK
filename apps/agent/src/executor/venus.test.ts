/**
 * Venus deposit and redeem (M1-05) against the recorded 1 USDT builds: the unlimited DeFi APPROVE
 * is never used, the calldata is checked before anything is signed, and a redemption can never
 * reach into the principal.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SimulationResult } from '@yieldvest/binance';
import { BSC_USDT, decodeApprove, decodeVenusCall, encodeApprove } from '@yieldvest/chain';
import { createDb, lastOutboxNonce, type Db } from '@yieldvest/db';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';
import { agentTestUrl } from '../../test/db.js';
import {
  cleanup,
  fakeApi,
  fakeChain,
  HOUSE,
  signer,
  testClock,
  transferLog,
} from '../../test/harness.js';
import type { TradeDeps } from './trade.js';
import { simulateAfterApproval } from './trade.js';
import { depositPrincipal, discoverVenusUsdt, redeemFromVenus, redeemLimit } from './venus.js';

const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', '..', 'fixtures');
const VUSDT = getAddress('0xfD5840Cd36d94D7229439859C0112a4185BC0255');
const INVESTMENT = '5b77bfd8d8f7c18e9ee0d8f331c4d78f56744eed8addbe2e9970c0ef37e763cb';
const ONE_USDT = 10n ** 18n;

interface Item {
  callDataType: string;
  from: string;
  to: string;
  value: string;
  data: string;
  gasLimit?: string;
  gasPrice: string;
  maxPriorityFeePerGas?: string;
  maxFeePerGas?: string;
}

function recorded(file: string): { dataList: Item[]; redeemDelayDays?: number[] } {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as {
    response: { body: { data: { dataList: Item[]; redeemDelayDays?: number[] } } };
  };
  const data = fixture.response.body.data;
  // The fixture redacts the house address; the build names the caller as `from`.
  return { ...data, dataList: data.dataList.map((item) => ({ ...item, from: HOUSE })) };
}

const RECORDED_LIST = (
  JSON.parse(
    readFileSync(path.join(FIXTURES, 'defi-data/listDeFiInvestments-20260924-1.json'), 'utf8'),
  ) as { response: { body: { data: { list: Record<string, unknown>[] } } } }
).response.body.data;
const DEPOSIT = recorded('defi-transaction/buildDeFiDepositTransaction-20260924-3.json');
const REDEEM = recorded('defi-transaction/buildDeFiRedeemTransaction-20260924-3.json');
const REDEEM_VTOKENS = decodeVenusCall(REDEEM.dataList[0]?.data ?? '').amount;
/** An exchange rate at which the recorded redeem is worth exactly 1 USDT. */
const RATE = (ONE_USDT * 10n ** 18n) / REDEEM_VTOKENS;

function world(mode: 'simulate' | 'live', db?: Db, startNonce = 0) {
  const clock = testClock('2026-09-28T14:00:00.000Z');
  const chain = fakeChain(startNonce);
  chain.exchangeRate = () => Promise.resolve(RATE);
  chain.underlyingOf = () => Promise.resolve(BSC_USDT);
  const simulated: { to: string; data: string }[] = [];
  let depositBuild = DEPOSIT;
  let redeemBuild = REDEEM;
  let investmentList: { list: Record<string, unknown>[] } = RECORDED_LIST;
  const api = fakeApi(clock, {
    // The recorded real response: its items name no asset tokens (the request filters by USDT).
    '/api/v1/defi/data/investment/list': () => investmentList,
    '/api/v1/defi/transaction/deposit': () => depositBuild,
    '/api/v1/defi/transaction/redeem': () => redeemBuild,
    '/api/v1/dex/pre-transaction/gas-limit': () => ({ gasLimit: '150000' }),
    '/api/v1/dex/pre-transaction/simulate': (_u, body) => {
      const call = (body as { evmTx: { to: string; data: string } }).evmTx;
      simulated.push(call);
      const allowed = chain.allowances.get(`${BSC_USDT}:${HOUSE}:${VUSDT}`.toLowerCase()) ?? 0n;
      const needsAllowance = call.data.startsWith('0xa0712d68');
      return !needsAllowance || allowed > 0n
        ? { status: 'SUCCESS', failReason: '', balanceChanges: [], allowanceChanges: [] }
        : {
            status: 'FAILED',
            failReason: 'execution reverted: BEP20: transfer amount exceeds allowance',
            balanceChanges: [],
            allowanceChanges: [],
          };
    },
    '/api/v1/dex/pre-transaction/broadcast-transaction': (_u, body) => ({
      txHash: chain.accept((body as { signedTransaction: Hex }).signedTransaction),
      orderId: null,
    }),
  });
  chain.onMine = (tx) => {
    if (tx.data.startsWith('0xa0712d68')) {
      return {
        status: 'success',
        logs: [
          transferLog(BSC_USDT, HOUSE, VUSDT, ONE_USDT),
          transferLog(VUSDT, VUSDT, HOUSE, 4_700_000_000n),
        ],
      };
    }
    if (tx.data.startsWith('0xdb006a75')) {
      return {
        status: 'success',
        logs: [
          transferLog(VUSDT, HOUSE, VUSDT, REDEEM_VTOKENS),
          transferLog(BSC_USDT, VUSDT, HOUSE, ONE_USDT),
        ],
      };
    }
    return { status: 'success', logs: [] };
  };
  const deps: TradeDeps = {
    mode,
    client: api.client,
    chain,
    db: db ?? (null as unknown as Db),
    house: HOUSE,
    ...(mode === 'live' ? { signer } : {}),
    log: () => undefined,
    now: () => new Date(clock.now()),
  };
  return {
    deps,
    api,
    chain,
    simulated,
    market: { investmentId: INVESTMENT, vToken: VUSDT },
    setDeposit: (build: typeof DEPOSIT) => (depositBuild = build),
    setRedeem: (build: typeof REDEEM) => (redeemBuild = build),
    setList: (list: Record<string, unknown>[]) => (investmentList = { list }),
  };
}

describe('discoverVenusUsdt', () => {
  it('finds the USDT investment in the real list response and checks the market on chain', async () => {
    const w = world('simulate');
    expect(await discoverVenusUsdt(w.deps)).toEqual({
      investmentId: INVESTMENT,
      vToken: VUSDT,
      apyBps: 316,
      apyDisplay: '3.16%',
    });
    w.chain.underlyingOf = () => Promise.resolve('0x0000000000000000000000000000000000000002');
    await expect(discoverVenusUsdt(w.deps)).rejects.toThrow('not USDT');
  });

  it('skips items that name other tokens, and refuses to guess between several', async () => {
    const w = world('simulate');
    const other = {
      investmentId: 'other',
      investType: 'Earn',
      assetTokenList: [{ tokenAddress: '0x0000000000000000000000000000000000000001' }],
    };
    const usdt = { investmentId: INVESTMENT, investType: 'Earn', investmentName: 'USDT' };
    w.setList([other, usdt]);
    expect(await discoverVenusUsdt(w.deps)).toMatchObject({ investmentId: INVESTMENT });
    w.setList([
      { investmentId: 'a', investType: 'Earn' },
      { investmentId: 'b', investType: 'Earn' },
    ]);
    await expect(discoverVenusUsdt(w.deps)).rejects.toThrow('not exactly one named USDT');
    w.setList([other]);
    await expect(discoverVenusUsdt(w.deps)).rejects.toThrow('no Venus USDT Earn investment');
  });
});

describe('depositPrincipal (simulate)', () => {
  it('simulates our exact approval, never the unlimited APPROVE item, and signs nothing', async () => {
    const w = world('simulate');
    const result = await depositPrincipal(w.deps, {
      planId: 'H-YIELD',
      market: w.market,
      amountUsd: '1',
    });
    expect(result).toMatchObject({
      kind: 'simulated',
      approve: { status: 'SUCCESS' },
      deposit: { status: 'FAILED' },
    });
    const approve = w.simulated[0];
    expect(approve?.to).toBe(BSC_USDT);
    expect(approve?.data).toBe(encodeApprove(VUSDT, ONE_USDT));
    expect(decodeApprove(DEPOSIT.dataList[0]?.data ?? '').amount).toBe(2n ** 256n - 1n);
    expect(w.chain.sent).toEqual([]);
  });

  it('refuses a DEPOSIT for another amount or another market', async () => {
    const w = world('simulate');
    const [approveItem, depositItem] = DEPOSIT.dataList;
    if (!approveItem || !depositItem) throw new Error('fixture');
    w.setDeposit({
      dataList: [
        approveItem,
        { ...depositItem, data: `0xa0712d68${(2n * ONE_USDT).toString(16).padStart(64, '0')}` },
      ],
    });
    expect(
      await depositPrincipal(w.deps, { planId: 'p', market: w.market, amountUsd: '1' }),
    ).toMatchObject({
      kind: 'failed',
      code: 'DEFI_WRONG_AMOUNT',
    });
    w.setDeposit({
      dataList: [approveItem, { ...depositItem, to: '0x0000000000000000000000000000000000000003' }],
    });
    expect(
      await depositPrincipal(w.deps, { planId: 'p', market: w.market, amountUsd: '1' }),
    ).toMatchObject({
      code: 'DEFI_WRONG_MARKET',
    });
  });
});

describe('redeemFromVenus (simulate)', () => {
  it('redeems what was asked when the calldata is worth no more than that', async () => {
    const w = world('simulate');
    expect(
      await redeemFromVenus(w.deps, {
        planId: 'p',
        cycleId: null,
        market: w.market,
        amountUsd: '1',
        planVTokens: REDEEM_VTOKENS,
      }),
    ).toMatchObject({ kind: 'simulated', redeem: { status: 'SUCCESS' }, vTokens: REDEEM_VTOKENS });
  });

  it('refuses to burn more vTokens than the plan holds, or more than the amount is worth', async () => {
    const w = world('simulate');
    expect(
      await redeemFromVenus(w.deps, {
        planId: 'p',
        cycleId: null,
        market: w.market,
        amountUsd: '1',
        planVTokens: REDEEM_VTOKENS - 1n,
      }),
    ).toMatchObject({ kind: 'failed', code: 'DEFI_REDEEM_TOO_LARGE' });
    // Asking for $0.50 while the calldata redeems $1: the rest would be principal.
    expect(
      await redeemFromVenus(w.deps, {
        planId: 'p',
        cycleId: null,
        market: w.market,
        amountUsd: '0.5',
        planVTokens: 10n ** 12n,
      }),
    ).toMatchObject({ kind: 'failed', code: 'DEFI_REDEEM_TOO_LARGE' });
  });

  it('refuses a redemption with a waiting period', async () => {
    const w = world('simulate');
    w.setRedeem({ ...REDEEM, redeemDelayDays: [1, 3] });
    expect(
      await redeemFromVenus(w.deps, {
        planId: 'p',
        cycleId: null,
        market: w.market,
        amountUsd: '1',
        planVTokens: REDEEM_VTOKENS,
      }),
    ).toMatchObject({ kind: 'failed', code: 'DEFI_REDEEM_DELAY' });
  });
});

describe('simulateAfterApproval (PD-07)', () => {
  const allowance: SimulationResult = {
    status: 'FAILED',
    failReason: 'execution reverted: BEP20: transfer amount exceeds allowance',
    balanceChanges: [],
    allowanceChanges: [],
  };
  const ok: SimulationResult = { ...allowance, status: 'SUCCESS', failReason: '' };
  const runs = (...results: SimulationResult[]) => {
    let i = 0;
    return {
      run: () => Promise.resolve(results[Math.min(i++, results.length - 1)] ?? ok),
      count: () => i,
    };
  };
  const waits: number[] = [];
  const deps = { log: () => undefined, sleep: (ms: number) => (waits.push(ms), Promise.resolve()) };

  it('simulates again, twice at most, when only the allowance just mined is missing', async () => {
    const lagging = runs(allowance, ok);
    expect(await simulateAfterApproval(deps, true, lagging.run)).toMatchObject(ok);
    expect(lagging.count()).toBe(2);
    const stuck = runs(allowance);
    expect(await simulateAfterApproval(deps, true, stuck.run)).toMatchObject(allowance);
    expect(stuck.count()).toBe(3);
    expect(waits).toEqual([1_500, 1_500, 1_500]);
  });

  it('takes the first answer without an approval of its own, or for any other revert', async () => {
    const noApproval = runs(allowance, ok);
    expect(await simulateAfterApproval(deps, false, noApproval.run)).toMatchObject(allowance);
    expect(noApproval.count()).toBe(1);
    const other = runs({ ...allowance, failReason: 'execution reverted: math error' }, ok);
    expect(await simulateAfterApproval(deps, true, other.run)).toMatchObject({
      failReason: 'execution reverted: math error',
    });
    expect(other.count()).toBe(1);
  });
});

/** vUSDT exchangeRateStored on chain at block 123664140 (dx/LOG.md 2026-09-24 00:49). */
const RATE_0924 = 265115854764046092440821898n;
/** One accrual of the stored rate, as measured on 10/3 (two moved it 3.4e-8 in 80 blocks). */
const ACCRUAL = (RATE_0924 * 17n) / 1_000_000_000n;

describe('the redeem bound at the real rate (PD-07)', () => {
  const redeemOf = (vTokens: bigint) => ({
    ...REDEEM,
    dataList: REDEEM.dataList.map((item) => ({
      ...item,
      data: encodeFunctionData({
        abi: parseAbi(['function redeem(uint256 redeemTokens) returns (uint256)']),
        functionName: 'redeem',
        args: [vTokens],
      }),
    })),
  });
  const redeemAt = async (rate: bigint, build = REDEEM, planVTokens = REDEEM_VTOKENS) => {
    const w = world('simulate');
    w.chain.exchangeRate = () => Promise.resolve(rate);
    w.setRedeem(build);
    return redeemFromVenus(w.deps, {
      planId: 'p',
      cycleId: null,
      market: w.market,
      amountUsd: '1',
      planVTokens,
    });
  };

  it('the recorded build burns what 1 USDT is worth at the stored rate of that minute', () => {
    expect(REDEEM_VTOKENS).toBe((ONE_USDT * 10n ** 18n) / RATE_0924);
    // Rounded up, plus one part per million, plus one vToken.
    expect(redeemLimit(ONE_USDT, RATE_0924)).toBe(REDEEM_VTOKENS + 1n + 3_771n + 1n);
    expect(() => redeemLimit(ONE_USDT, 0n)).toThrow(/positive/);
  });

  it('accepts the build when interest accrued between the API’s read and ours, either way', async () => {
    // Ours older than the API's (the usual order: we read before the build), the same, or newer
    // by one accrual up to thirty (the API's node behind ours). The old bound — one vToken over the
    // amount at a rate read after the build — refused a $1 redeem at the first accrual.
    for (const rate of [
      RATE_0924 - ACCRUAL,
      RATE_0924,
      RATE_0924 + ACCRUAL,
      RATE_0924 + 30n * ACCRUAL,
    ]) {
      expect(await redeemAt(rate)).toMatchObject({ kind: 'simulated', vTokens: REDEEM_VTOKENS });
    }
  });

  it('still refuses calldata beyond one part per million, or beyond the plan’s own vTokens', async () => {
    const twoPpm = REDEEM_VTOKENS + REDEEM_VTOKENS / 500_000n;
    expect(await redeemAt(RATE_0924, redeemOf(twoPpm), 10n ** 12n)).toMatchObject({
      kind: 'failed',
      code: 'DEFI_REDEEM_TOO_LARGE',
    });
    // A node more than about sixty accruals behind ours is refused too: nothing is signed.
    expect(await redeemAt(RATE_0924 + 70n * ACCRUAL)).toMatchObject({
      kind: 'failed',
      code: 'DEFI_REDEEM_TOO_LARGE',
    });
    expect(await redeemAt(RATE_0924, REDEEM, REDEEM_VTOKENS - 1n)).toMatchObject({
      kind: 'failed',
      code: 'DEFI_REDEEM_TOO_LARGE',
    });
  });
});

const url = agentTestUrl;

describe.skipIf(!url)('Venus live path on Postgres (fake chain)', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const planIds: string[] = [];
  afterAll(async () => {
    await cleanup(db, planIds, []);
    await close();
  });

  it('deposits with an exact approval, then redeems, reading amounts from the logs', async () => {
    const { insertPlan } = await import('@yieldvest/db');
    const planId = `T-${Date.now()}-venus`;
    planIds.push(planId);
    await insertPlan(db, {
      id: planId,
      ownerKind: 'house',
      mode: 'yield',
      ticker: 'QQQ',
      issuerPreference: ['bstocks'],
      cadence: 'weekly',
      window: 'regular_session',
      maxPerBuyUsd: '5',
      maxDailyUsd: '5',
      status: 'paused',
      nextDueAt: '2026-09-28T13:32:00.000Z',
    });
    const last = await lastOutboxNonce(db, 56, HOUSE);
    const w = world('live', db, last === undefined ? 0 : last + 1);
    const deposited = await depositPrincipal(w.deps, { planId, market: w.market, amountUsd: '1' });
    expect(deposited).toMatchObject({
      kind: 'deposited',
      vTokensMinted: 4_700_000_000n,
      usdtSpent: ONE_USDT,
    });
    expect(w.chain.sent.map((tx) => tx.data.slice(0, 10))).toEqual(['0x095ea7b3', '0xa0712d68']);
    expect(decodeApprove(w.chain.sent[0]?.data ?? '')).toEqual({
      spender: VUSDT,
      amount: ONE_USDT,
    });

    const redeemed = await redeemFromVenus(w.deps, {
      planId,
      cycleId: null,
      market: w.market,
      amountUsd: '1',
      planVTokens: REDEEM_VTOKENS,
    });
    expect(redeemed).toMatchObject({
      kind: 'redeemed',
      usdtReceived: ONE_USDT,
      vTokensBurned: REDEEM_VTOKENS,
    });
  });

  it('simulates the deposit again while the API’s node has not seen the approval yet', async () => {
    const { insertPlan } = await import('@yieldvest/db');
    const planId = `T-${Date.now()}-venus-lag`;
    planIds.push(planId);
    await insertPlan(db, {
      id: planId,
      ownerKind: 'house',
      mode: 'yield',
      ticker: 'QQQ',
      issuerPreference: ['bstocks'],
      cadence: 'weekly',
      window: 'regular_session',
      maxPerBuyUsd: '5',
      maxDailyUsd: '5',
      status: 'paused',
      nextDueAt: '2026-09-28T13:32:00.000Z',
    });
    const last = await lastOutboxNonce(db, 56, HOUSE);
    const w = world('live', db, last === undefined ? 0 : last + 1);
    const lines: string[] = [];
    const waits: number[] = [];
    const deps: TradeDeps = {
      ...w.deps,
      log: (line) => lines.push(line),
      sleep: (ms) => (waits.push(ms), Promise.resolve()),
    };
    // The approval is mined on our node; the API simulates the deposit on one a block behind.
    const simulateRoute = w.api.routes['/api/v1/dex/pre-transaction/simulate'];
    let behind = true;
    w.api.routes['/api/v1/dex/pre-transaction/simulate'] = (u, body) => {
      const data = (body as { evmTx: { data: string } }).evmTx.data;
      if (data.startsWith('0xa0712d68') && behind) {
        behind = false;
        return {
          status: 'FAILED',
          failReason: 'execution reverted: BEP20: transfer amount exceeds allowance',
          balanceChanges: [],
          allowanceChanges: [],
        };
      }
      return simulateRoute?.(u, body);
    };
    expect(
      await depositPrincipal(deps, { planId, market: w.market, amountUsd: '1' }),
    ).toMatchObject({ kind: 'deposited', usdtSpent: ONE_USDT });
    expect(waits).toEqual([1_500]);
    expect(lines.join('\n')).toMatch(/right after our approval was mined/);
    expect(w.chain.sent.map((tx) => tx.data.slice(0, 10))).toEqual(['0x095ea7b3', '0xa0712d68']);
  });
});
