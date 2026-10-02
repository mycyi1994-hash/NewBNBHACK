/**
 * A whole fake world for cycle, scheduler and guardian tests: a registered test instrument, a
 * Binance Web3 API answering with fixture-shaped data, and an in-memory chain on which approvals
 * set allowances and swaps deliver tokens. Guardian inputs (Venus TVL, USDT price) are settable.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { decodeVenusCall, encodeApprove } from '@yieldvest/chain';
import { toUnits, underlyingFromVTokens } from '@yieldvest/core';
import { parseConfig } from '@yieldvest/config';
import {
  insertPlan,
  lastOutboxNonce,
  upsertInstruments,
  type Db,
  type InstrumentRow,
  type PlanInsert,
} from '@yieldvest/db';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { createAlerter } from '../src/alerts.js';
import type { CycleDeps } from '../src/cycle.js';
import {
  fakeApi,
  fakeChain,
  HOUSE,
  ROUTER,
  signer,
  testClock,
  TOKEN,
  transferLog,
  type FakeApi,
  type FakeChain,
} from './harness.js';

export const USDT = '0x55d398326f99059fF775485246999027B3197955';
export const RECEIVED = 22_212_154_002_358_266n; // tokens for $5 at ~$225
export const VUSDT: Hex = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';

export interface World {
  clock: ReturnType<typeof testClock>;
  chain: FakeChain;
  api: FakeApi;
  deps(mode: 'simulate' | 'live'): CycleDeps;
  lines: string[];
  alerts: string[];
  /** Guardian inputs the fake API reports. */
  market: { usdtPrice: string; venusTvl: string };
}

/** Registers a fresh test instrument (its own ticker, so tests never share one). */
export async function testInstrument(db: Db): Promise<{ ticker: string; instrumentId: string }> {
  // Letters only, like every ticker the web accepts (apps/web/lib/server/schemas.ts): T + five.
  const ticker = `T${Array.from(randomBytes(5), (b) => String.fromCharCode(65 + (b % 26))).join('')}`;
  const row: InstrumentRow = {
    id: `${ticker}:bstocks`,
    ticker,
    issuer: 'bstocks',
    platformId: 'bstock',
    chainId: 56,
    address: TOKEN,
    symbol: `${ticker}B`,
    decimals: 18,
    assetType: 1,
    multiplier: '1.000778223752807865',
    multiplierSource: 'onchain',
    apiShareRatio: '1.000778223752807865',
    verifiedAt: '2026-09-24T00:45:40.000Z',
  };
  await upsertInstruments(db, [row]);
  return { ticker, instrumentId: row.id };
}

/** A house plan of `ticker` due at the first regular open after the test start. */
export async function testPlan(
  db: Db,
  ticker: string,
  overrides: Partial<PlanInsert> = {},
): Promise<string> {
  const id = `T-${randomUUID()}`;
  await insertPlan(db, {
    id,
    ownerKind: 'house',
    mode: 'safe',
    ticker,
    issuerPreference: ['bstocks', 'ondo'],
    contributionUsd: '5',
    cadence: 'daily',
    window: 'regular_session',
    maxPerBuyUsd: '5',
    maxDailyUsd: '5',
    status: 'active',
    nextDueAt: '2026-09-28T13:32:00.000Z',
    ...overrides,
  });
  return id;
}

export async function createWorld(
  db: Db,
  start: string,
  opts: { exactApprove?: boolean } = {},
): Promise<World> {
  const clock = testClock(start);
  const last = await lastOutboxNonce(db, 56, HOUSE);
  const chain = fakeChain(last === undefined ? 0 : last + 1);
  chain.onMine = (tx) =>
    tx.to.toLowerCase() === ROUTER.toLowerCase()
      ? {
          status: 'success',
          logs: [
            transferLog(USDT, HOUSE, ROUTER, 5n * 10n ** 18n),
            transferLog(TOKEN, ROUTER, HOUSE, RECEIVED),
          ],
        }
      : { status: 'success', logs: [] };
  const allowance = () => chain.allowances.get(`${USDT}:${HOUSE}:${ROUTER}`.toLowerCase()) ?? 0n;
  let swapAmount = 0n;
  const market = { usdtPrice: '1.0001', venusTvl: '1353914642' };
  const api = fakeApi(clock, {
    '/api/v1/dex/market/rwa/tokens': () => [
      {
        tokenContractAddress: TOKEN,
        statusInfo: { openState: true, marketStatus: null, reasonCode: 'TRADING', reasonMsg: null },
      },
    ],
    '/api/v1/dex/market/rwa/price': () => [
      {
        tokenContractAddress: TOKEN,
        tokenPrice: '225.2',
        referencePrice: '225.02',
        tokenPriceUpdatedAt: 0,
      },
    ],
    '/api/v1/dex/market/price': () => [
      {
        binanceChainId: '56',
        tokenContractAddress: USDT,
        price: market.usdtPrice,
        time: clock.now(),
      },
    ],
    '/api/v1/defi/data/protocol/detail': () => ({
      defiProtocolId: 'venus',
      tvl: market.venusTvl,
      securityScore: '93.1',
    }),
    '/api/v1/dex/aggregator/quote': (u) => [
      {
        quoteId: `q-${clock.now()}`,
        vendorName: 'LiquidMesh',
        executionMode: 'SWAP',
        fromTokenAmount: u.searchParams.get('amount'),
        toTokenAmount: RECEIVED.toString(),
        priceImpactPercent: '0.0000000000',
        approveTarget: ROUTER,
        isBest: true,
      },
    ],
    '/api/v1/dex/aggregator/approve-transaction': (u) => {
      const amount = BigInt(u.searchParams.get('approveAmount') ?? '0');
      return [
        {
          data: encodeApprove(ROUTER, opts.exactApprove === false ? 2n ** 256n - 1n : amount),
          dexContractAddress: ROUTER,
          gasLimit: '63448',
          gasPrice: '58339710',
        },
      ];
    },
    '/api/v1/dex/aggregator/swap': (u) => {
      swapAmount = BigInt(u.searchParams.get('amount') ?? '0');
      return {
        tx: {
          from: u.searchParams.get('userWalletAddress'),
          to: ROUTER,
          data: '0xad43f73d',
          value: '0',
          gas: '450000',
          gasPrice: '58339710',
          maxPriorityFeePerGas: '58339710',
          minReceiveAmount: '22101093232346474',
        },
        executionMode: 'SWAP',
        rfq: null,
      };
    },
    '/api/v1/dex/pre-transaction/simulate': (_u, body) => {
      const call = (body as { evmTx: { to: string; data: string } }).evmTx;
      const ok = { status: 'SUCCESS', failReason: '', balanceChanges: [], allowanceChanges: [] };
      if (call.data.startsWith('0x095ea7b3')) return ok;
      // The swap pulls what it was built for: an allowance under that amount reverts.
      return allowance() >= swapAmount
        ? ok
        : {
            status: 'FAILED',
            failReason: 'execution reverted: BEP20: transfer amount exceeds allowance',
            balanceChanges: [],
            allowanceChanges: [],
          };
    },
    '/api/v1/dex/pre-transaction/broadcast-transaction': (_u, body) => {
      const raw = (body as { signedTransaction: Hex }).signedTransaction;
      return { txHash: chain.accept(raw), orderId: 'o-1' };
    },
  });
  const lines: string[] = [];
  const alerts: string[] = [];
  const config = parseConfig({});
  return {
    clock,
    chain,
    api,
    lines,
    alerts,
    market,
    deps: (mode) => ({
      mode,
      client: api.client,
      chain,
      db,
      house: HOUSE,
      ...(mode === 'live' ? { signer } : {}),
      log: (line) => lines.push(line),
      now: () => new Date(clock.now()),
      config,
      alerter: createAlerter({ log: (line) => alerts.push(line), now: () => clock.now() }),
      stockQuote: () => Promise.resolve({ ok: true, stockPrice: '225.00' }),
      venus: { investmentId: 'venus-usdt', vToken: VUSDT },
    }),
  };
}

/** The fake chain's vUSDT exchange rate: one USDT is 1e8 vTokens. */
export const VENUS_RATE = 10n ** 28n;
const MINT_SELECTOR = '0xa0712d68';
const REDEEM_SELECTOR = '0xdb006a75';
const vTokenAbi = parseAbi([
  'function mint(uint256 mintAmount) returns (uint256)',
  'function redeem(uint256 redeemTokens) returns (uint256)',
]);

/**
 * Adds Venus deposit and redeem to a world: the DeFi builds carry mint(amount) / redeem(vTokens
 * the amount is worth) like the recorded ones, simulations pass (or fail when told to), and
 * mining moves USDT and vTokens between the house and vUSDT.
 */
export function withVenus(w: World) {
  const state: {
    redeemSimulation: { status: string; failReason: string };
    /** Set: every mint simulation fails with this reason (a paused market, say). */
    mintFailure?: string;
  } = { redeemSimulation: { status: 'SUCCESS', failReason: '' } };
  const item = (callDataType: string, data: Hex) => ({
    callDataType,
    from: HOUSE,
    to: VUSDT,
    value: '0x0',
    data,
    gasPrice: '64257210',
    maxPriorityFeePerGas: '64257210',
    maxFeePerGas: '64257210',
  });
  const amountOf = (body: unknown) =>
    toUnits((body as { token: { amount: string } }).token.amount, 18);
  w.api.routes['/api/v1/defi/transaction/deposit'] = (_u, body) => ({
    dataList: [
      item('APPROVE', encodeApprove(VUSDT, 2n ** 256n - 1n)),
      item(
        'DEPOSIT',
        encodeFunctionData({ abi: vTokenAbi, functionName: 'mint', args: [amountOf(body)] }),
      ),
    ],
  });
  w.api.routes['/api/v1/defi/transaction/redeem'] = (_u, body) => ({
    redeemDelayDays: [],
    dataList: [
      item(
        'REDEEM',
        encodeFunctionData({
          abi: vTokenAbi,
          functionName: 'redeem',
          args: [(amountOf(body) * 10n ** 18n) / VENUS_RATE],
        }),
      ),
    ],
  });
  w.api.routes['/api/v1/dex/pre-transaction/gas-limit'] = () => ({ gasLimit: '150000' });
  const simulate = w.api.routes['/api/v1/dex/pre-transaction/simulate'];
  w.api.routes['/api/v1/dex/pre-transaction/simulate'] = (u, body) => {
    const data = (body as { evmTx: { data: string } }).evmTx.data;
    if (data.startsWith(REDEEM_SELECTOR)) {
      return { ...state.redeemSimulation, balanceChanges: [], allowanceChanges: [] };
    }
    const ok = { status: 'SUCCESS', failReason: '', balanceChanges: [], allowanceChanges: [] };
    if (data.startsWith('0x095ea7b3')) return ok;
    if (data.startsWith(MINT_SELECTOR)) {
      if (state.mintFailure) return { ...ok, status: 'FAILED', failReason: state.mintFailure };
      // A mint pulls its USDT through the allowance: one that was only simulated is not there,
      // as on BSC (the Transaction API simulates one transaction at a time, DECISIONS Q-05).
      const allowed = w.chain.allowances.get(`${USDT}:${HOUSE}:${VUSDT}`.toLowerCase()) ?? 0n;
      return allowed >= decodeVenusCall(data).amount
        ? ok
        : {
            ...ok,
            status: 'FAILED',
            failReason: 'execution reverted: BEP20: transfer amount exceeds allowance',
          };
    }
    return simulate?.(u, body);
  };
  const mine = w.chain.onMine;
  w.chain.onMine = (tx) => {
    if (tx.data.startsWith(REDEEM_SELECTOR)) {
      const vTokens = decodeVenusCall(tx.data).amount;
      return {
        status: 'success',
        logs: [
          transferLog(VUSDT, HOUSE, VUSDT, vTokens),
          transferLog(USDT, VUSDT, HOUSE, underlyingFromVTokens(vTokens, VENUS_RATE)),
        ],
      };
    }
    if (tx.data.startsWith(MINT_SELECTOR)) {
      const usdt = decodeVenusCall(tx.data).amount;
      return {
        status: 'success',
        logs: [
          transferLog(USDT, HOUSE, VUSDT, usdt),
          transferLog(VUSDT, VUSDT, HOUSE, (usdt * 10n ** 18n) / VENUS_RATE),
        ],
      };
    }
    return mine(tx);
  };
  return state;
}
