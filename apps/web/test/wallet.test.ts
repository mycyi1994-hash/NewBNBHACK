/**
 * "My wallet" (DECISIONS D-32): the view from one chain reading — shares at the bStocks token's own
 * on-chain multiplier, a scheduled change, Ondo's registry multiplier, values from the tape, the
 * Venus position, reads that failed — and GET /api/wallet on the web tests' Postgres with the
 * fake chain: the plans that use the wallet, any case of the address, an RPC that is down.
 */
import type { Instrument } from '@yieldvest/core';
import {
  createDb,
  tapeSamples,
  upsertInstruments,
  workerStatus,
  writeWorkerStatus,
  type InstrumentRow,
  type TapeSampleRow,
} from '@yieldvest/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as createPlan } from '../app/api/plans/route';
import { GET as walletRoute } from '../app/api/wallet/route';
import { setChainForTests, type WalletReading } from '../lib/server/chain';
import { resetContext } from '../lib/server/context';
import type { TapeView } from '../lib/server/market';
import { walletFromReading, type WalletView } from '../lib/server/wallet';
import { webTestUrl } from './db';
import {
  call,
  cleanup,
  E18,
  fakeWebChain,
  randomAddress,
  testInstrument,
  writeTape,
} from './harness';

const NOW = new Date('2026-10-06T15:00:00.000Z');
const WALLET = '0x00000000000000000000000000000000000000aa';
const VTOKEN = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';

const instrument = (over: Partial<Instrument>): Instrument => ({
  id: 'NVDA:bstocks',
  ticker: 'NVDA',
  issuer: 'bstocks',
  chainId: 56,
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'NVDAB',
  decimals: 18,
  // Deliberately not the chain's value: the view must read the chain's.
  multiplier: '1.0007',
  verifiedAt: '2026-09-24T00:45:40.000Z',
  ...over,
});

const BSTOCKS = instrument({});
const ONDO = instrument({
  id: 'NVDA:ondo',
  issuer: 'ondo',
  address: '0x2222222222222222222222222222222222222222',
  symbol: 'NVDAon',
  multiplier: '1',
});
const TSLA = instrument({
  id: 'TSLA:bstocks',
  ticker: 'TSLA',
  address: '0x3333333333333333333333333333333333333333',
  symbol: 'TSLAB',
});
const AAPL = instrument({
  id: 'AAPL:ondo',
  ticker: 'AAPL',
  issuer: 'ondo',
  address: '0x4444444444444444444444444444444444444444',
  symbol: 'AAPLon',
  multiplier: '1',
});

const row = (instrumentId: string, tokenPrice: string): TapeSampleRow =>
  ({ instrumentId, tokenPrice, sizeUsd: 5 }) as TapeSampleRow;

const tape = (state: TapeView['state'], rows: TapeSampleRow[]): TapeView => ({
  state,
  sampledAt: state === 'UNAVAILABLE' ? null : '2026-10-06T14:58:00.000Z',
  slotAt: null,
  ageSeconds: state === 'UNAVAILABLE' ? null : 120,
  rows,
});

function reading(over: Partial<WalletReading> = {}): WalletReading {
  return {
    blockNumber: 62_000_000n,
    blockTime: BigInt(NOW.getTime() / 1000),
    balances: new Map([
      [BSTOCKS.address.toLowerCase(), 2n * E18],
      [ONDO.address.toLowerCase(), (3n * E18) / 2n],
      [TSLA.address.toLowerCase(), 0n],
      // AAPL's balance did not come back.
    ]),
    multipliers: new Map([
      [
        BSTOCKS.address.toLowerCase(),
        {
          uiMultiplier: 1_000_778_223_752_807_865n,
          newUIMultiplier: 1_050_000_000_000_000_000n,
          effectiveAt: BigInt(NOW.getTime() / 1000 + 86_400),
        },
      ],
    ]),
    usdt: 12_340_000_000_000_000_000n,
    venus: { vTokens: 50_000_000_000n, exchangeRate: 212_000_000_000_000_000_000_000_000n },
    ...over,
  };
}

const view = (over: Partial<Parameters<typeof walletFromReading>[0]> = {}): WalletView =>
  walletFromReading({
    address: WALLET,
    instruments: [BSTOCKS, ONDO, TSLA, AAPL],
    reading: reading(),
    vToken: VTOKEN,
    tape: tape('LIVE', [row(BSTOCKS.id, '225.175'), row(ONDO.id, '225.40')]),
    plans: [],
    now: NOW,
    ...over,
  });

describe('walletFromReading', () => {
  it('counts shares at the bStocks token’s own on-chain multiplier and names a scheduled change', () => {
    const v = view();
    expect(v.address).toBe('0x00000000000000000000000000000000000000AA');
    expect(v.chain).toEqual({
      state: 'LIVE',
      blockNumber: '62000000',
      readAt: NOW.toISOString(),
    });
    expect(v.stocks.map((s) => s.symbol)).toEqual(['NVDAB', 'NVDAon']);
    const [bstocks, ondo] = v.stocks;
    expect(bstocks).toMatchObject({
      tokens: '2',
      // 2 × 1.000778223752807865 (the chain's), not 2 × 1.0007 (the registry's).
      shares: '2.001556',
      multiplier: '1.000778223752807865',
      multiplierSource: 'chain',
      pendingChange: { to: '1.05', effectiveAt: '2026-10-07T15:00:00.000Z' },
      // 2 tokens × 225.175.
      valueUsd: '450.35',
    });
    expect(ondo).toMatchObject({
      tokens: '1.5',
      shares: '1.5',
      multiplierSource: 'registry',
      pendingChange: null,
      valueUsd: '338.1',
    });
  });

  it('leaves out empty balances and counts the reads that failed', () => {
    const v = view();
    expect(v.checked).toBe(4);
    expect(v.unread).toBe(1);
    expect(v.stocks.some((s) => s.symbol === 'TSLAB')).toBe(false);
  });

  it('reads the wallet’s USDT and its Venus position', () => {
    const v = view();
    expect(v.usdt).toBe('12.34');
    // 500 vTokens (8 decimals) × 0.0212 USDT each.
    expect(v.venus).toEqual({ state: 'LIVE', usdt: '10.6', vTokens: '50000000000' });
    expect(view({ vToken: null }).venus).toEqual({
      state: 'UNAVAILABLE',
      reason: 'Venus market not verified yet',
    });
    expect(view({ reading: reading({ venus: null }) }).venus).toEqual({
      state: 'UNAVAILABLE',
      reason: 'Venus position not read',
    });
  });

  it('a change already in effect, or none scheduled, is no pending change', () => {
    const past = reading({
      multipliers: new Map([
        [
          BSTOCKS.address.toLowerCase(),
          {
            uiMultiplier: 1_000_778_223_752_807_865n,
            newUIMultiplier: 1_050_000_000_000_000_000n,
            effectiveAt: BigInt(NOW.getTime() / 1000 - 60),
          },
        ],
      ]),
    });
    expect(view({ reading: past }).stocks[0]?.pendingChange).toBeNull();
    // No multiplier read for the bStocks token: the registry's, said so.
    const unread = view({ reading: reading({ multipliers: new Map() }) }).stocks[0];
    expect(unread).toMatchObject({ multiplier: '1.0007', multiplierSource: 'registry' });
  });

  it('values come from the tape and carry its state; without a tape there is no value', () => {
    const stale = view({ tape: tape('STALE', [row(BSTOCKS.id, '225.175')]) });
    expect(stale.prices.state).toBe('STALE');
    expect(stale.stocks[0]?.valueUsd).toBe('450.35');
    expect(stale.stocks[1]?.valueUsd).toBeNull();
    const none = view({ tape: tape('UNAVAILABLE', []) });
    expect(none.stocks.every((s) => s.valueUsd === null)).toBe(true);
    // Rounded down to the cent: 2 × 225.17999 = 450.35998.
    expect(view({ tape: tape('LIVE', [row(BSTOCKS.id, '225.17999')]) }).stocks[0]?.valueUsd).toBe(
      '450.35',
    );
  });

  it('an RPC that did not answer is UNAVAILABLE with the reason, and nothing is made up', () => {
    const v = view({ reading: { error: 'BSC RPC did not answer' } });
    expect(v.chain).toEqual({ state: 'UNAVAILABLE', reason: 'BSC RPC did not answer' });
    expect(v).toMatchObject({ stocks: [], unread: 4, usdt: null });
    expect(v.venus).toEqual({ state: 'UNAVAILABLE', reason: 'BSC RPC did not answer' });
  });
});

describe.skipIf(!webTestUrl)('GET /api/wallet', () => {
  const { db, close } = createDb(webTestUrl ?? 'postgres://unused');
  const chain = fakeWebChain();
  const planIds: string[] = [];
  const tokenIds: string[] = [];
  let bstocks: InstrumentRow;
  let ondo: InstrumentRow;

  beforeAll(async () => {
    await db.delete(workerStatus);
    await db.delete(tapeSamples);
    bstocks = await testInstrument(db);
    ondo = {
      ...bstocks,
      id: `${bstocks.ticker}:ondo`,
      issuer: 'ondo',
      platformId: 'ondo',
      address: randomAddress(),
      symbol: `${bstocks.ticker}on`,
      multiplier: '1',
      apiShareRatio: '1',
    };
    await upsertInstruments(db, [ondo]);
    setChainForTests(chain);
  });
  afterEach(() => {
    vi.useRealTimers();
    chain.rpcDown = false;
  });
  afterAll(async () => {
    setChainForTests(undefined);
    await db.delete(workerStatus);
    await cleanup(db, { planIds, tokenIds, instrumentIds: [bstocks.id, ondo.id] });
    await resetContext();
    await close();
  });

  it('reads the wallet’s stocks in shares, its Venus position and the plans that use it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const wallet = randomAddress();
    chain.holdings.balances.set(bstocks.address.toLowerCase(), 3n * E18);
    chain.holdings.multipliers.set(bstocks.address.toLowerCase(), {
      uiMultiplier: 1_000_778_223_752_807_865n,
      newUIMultiplier: 1_000_778_223_752_807_865n,
      effectiveAt: 0n,
    });
    await writeTape(db, bstocks, new Date(NOW.getTime() - 60_000).toISOString());
    await writeWorkerStatus(db, 'venus', { vToken: VTOKEN });
    const created = await call<{ plan: { id: string }; tokenId: string }>(createPlan, {
      path: '/api/plans',
      body: {
        owner: 'skill',
        walletAddress: wallet,
        ticker: bstocks.ticker,
        issuer: 'bstocks',
        contributionUsd: '5',
        maxPerBuyUsd: '5',
        maxDailyUsd: '5',
      },
    });
    expect(created.status).toBe(201);
    planIds.push(created.body.plan.id);
    tokenIds.push(created.body.tokenId);

    // Any case of the address finds the same plans.
    const res = await call<WalletView>(walletRoute, {
      path: `/api/wallet?address=${wallet.toLowerCase()}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(wallet);
    expect(res.body.chain).toMatchObject({ state: 'LIVE', blockNumber: '62000000' });
    expect(res.body.stocks).toEqual([
      expect.objectContaining({
        ticker: bstocks.ticker,
        issuer: 'bstocks',
        tokens: '3',
        shares: '3.002334',
        multiplierSource: 'chain',
        pendingChange: null,
        // 3 tokens × 225.175 on the tape.
        valueUsd: '675.52',
      }),
    ]);
    expect(res.body.prices.state).toBe('LIVE');
    expect(res.body.venus.state).toBe('LIVE');
    expect(res.body.plans.map((p) => p.id)).toEqual([created.body.plan.id]);
    expect(JSON.stringify(res.body)).not.toContain('yv_');
  });

  it('an RPC that is down: the chain is UNAVAILABLE, the plans on record still show', async () => {
    chain.rpcDown = true;
    const res = await call<WalletView>(walletRoute, {
      path: `/api/wallet?address=${randomAddress()}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.chain).toEqual({ state: 'UNAVAILABLE', reason: 'BSC RPC did not answer' });
    expect(res.body.stocks).toEqual([]);
  });

  it('refuses what is not an address', async () => {
    for (const address of ['', '0x12', 'vitalik.eth', `0x${'g'.repeat(40)}`]) {
      const res = await call(walletRoute, { path: `/api/wallet?address=${address}` });
      expect([address, res.status]).toEqual([address, 400]);
    }
    expect((await call(walletRoute, { path: '/api/wallet' })).status).toBe(400);
  });
});
