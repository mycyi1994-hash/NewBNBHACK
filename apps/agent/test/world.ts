/**
 * A whole fake world for cycle, scheduler and guardian tests: a registered test instrument, a
 * Binance Web3 API answering with fixture-shaped data, and an in-memory chain on which approvals
 * set allowances and swaps deliver tokens. Guardian inputs (Venus TVL, USDT price) are settable.
 */
import { randomUUID } from 'node:crypto';
import { encodeApprove } from '@ijaro/chain';
import { parseConfig } from '@ijaro/config';
import {
  insertPlan,
  lastOutboxNonce,
  upsertInstruments,
  type Db,
  type InstrumentRow,
  type PlanInsert,
} from '@ijaro/db';
import type { Hex } from 'viem';
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
  const ticker = `T${randomUUID().slice(0, 6).toUpperCase()}`;
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
    '/api/v1/defi/data/protocol/detail': () => ({ defiProtocolId: 'venus', tvl: market.venusTvl }),
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
    '/api/v1/dex/aggregator/swap': (u) => ({
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
    }),
    '/api/v1/dex/pre-transaction/simulate': (_u, body) => {
      const call = (body as { evmTx: { to: string; data: string } }).evmTx;
      const ok = { status: 'SUCCESS', failReason: '', balanceChanges: [], allowanceChanges: [] };
      if (call.data.startsWith('0x095ea7b3')) return ok;
      return allowance() >= 5n * 10n ** 18n
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
