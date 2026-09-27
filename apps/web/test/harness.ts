/**
 * Route-handler test kit: requests shaped like the browser's or the skill's, a fake chain behind
 * setChainForTests, a registered test instrument and tape runs written the way the worker writes
 * them. Everything runs against the web tests' own Postgres (test/db.ts); nothing leaves the host.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { BSC_USDT } from '@yieldvest/chain';
import { fromUnits } from '@yieldvest/core';
import {
  cycles,
  guardianEvents,
  holdings,
  insertTapeSamples,
  instruments,
  jobs,
  judgeCodes,
  plans,
  receipts,
  sha256Hex,
  skillTokens,
  spendLedger,
  tapeSamples,
  txOutbox,
  upsertInstruments,
  type Db,
  type InstrumentRow,
  type TapeSampleInsert,
} from '@yieldvest/db';
import { inArray } from 'drizzle-orm';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiItem,
  type Hex,
  type Log,
} from 'viem';
import type { WebChain } from '../lib/server/chain';
import type { MinedTx } from '../lib/server/report';

export const USDT = getAddress(BSC_USDT);
export const ROUTER = getAddress('0xb44446b0c8e56988c34f7ff73ae904982b5fdda5');
/** Tokens a $1 buy receives in the test tape (~$225 a share at multiplier ≈ 1.0008). */
export const TOKENS_PER_USD = 4_442_430_800_471_653n;
export const E18 = 10n ** 18n;

type Handler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Response | Promise<Response>;

export interface CallInit {
  method?: 'GET' | 'POST';
  path: string;
  /** JSON-encoded unless it is a string already (then sent as is). */
  body?: unknown;
  cookie?: string;
  token?: string;
  /** Route params, e.g. { id }. */
  id?: string;
  /** Defaults to a fresh address per call, so per-address limits never leak between tests. */
  ip?: string;
}

export interface Called<T> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export async function call<T = Record<string, unknown>>(
  handler: Handler,
  init: CallInit,
): Promise<Called<T>> {
  const headers = new Headers({
    'x-forwarded-for': init.ip ?? `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`,
  });
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  let body: string | undefined;
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  }
  const request = new Request(`https://yieldvest.test${init.path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const response = await handler(request, { params: Promise.resolve({ id: init.id ?? '' }) });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (text ? JSON.parse(text) : null) as T,
    text,
  };
}

/** The `name=value` part of a Set-Cookie header, as a browser would send it back. */
export function cookieFrom(response: Called<unknown>): string {
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('no Set-Cookie in the response');
  return cookie;
}

export const randomAddress = () => getAddress(`0x${randomBytes(20).toString('hex')}`);
export const randomHash = (): Hex => `0x${randomBytes(32).toString('hex')}`;

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export function transferLog(token: string, from: string, to: string, value: bigint): Log {
  return {
    address: getAddress(token),
    topics: encodeEventTopics({
      abi: [transferEvent],
      eventName: 'Transfer',
      args: { from: getAddress(from), to: getAddress(to) },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  };
}

export interface FakeWebChain extends WebChain {
  /** Mined transactions by lowercase hash; anything else is not mined (yet). */
  txs: Map<string, MinedTx>;
  block: bigint;
  /** What vTokenBalance reports for any wallet (default: more than any plan holds). */
  walletVTokens: bigint;
  /** vToken → underlying rate (18 decimals of USD per vToken unit, scaled by 1e18). */
  rate: bigint;
  rpcDown: boolean;
  /** Mined now (the clock the routes read) unless a block time is given. */
  mine(
    hash: Hex,
    tx: Omit<MinedTx, 'blockNumber' | 'timestamp'> & { blockNumber?: bigint; timestamp?: bigint },
  ): void;
}

export function fakeWebChain(): FakeWebChain {
  const chain: FakeWebChain = {
    txs: new Map(),
    block: 62_000_000n,
    walletVTokens: 10n ** 30n,
    rate: 212_000_000_000_000_000_000_000_000n, // 0.0212 USDT per vToken unit (8 decimals)
    rpcDown: false,
    mine(hash, tx) {
      chain.txs.set(hash.toLowerCase(), {
        blockNumber: chain.block,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
        ...tx,
      });
    },
    blockNumber: () =>
      chain.rpcDown ? Promise.reject(new Error('fetch failed')) : Promise.resolve(chain.block),
    mined: (hash) => Promise.resolve(chain.txs.get(hash.toLowerCase())),
    vTokenBalance: () => Promise.resolve(chain.walletVTokens),
    vTokensUsd: (_vToken, vTokens) => Promise.resolve(fromUnits((vTokens * chain.rate) / E18, 18)),
  };
  return chain;
}

/** A registered bStocks test instrument with its own letters-only ticker and address. */
export async function testInstrument(db: Db): Promise<InstrumentRow> {
  const letters = Array.from(randomBytes(5), (b) => String.fromCharCode(65 + (b % 26))).join('');
  const ticker = `W${letters}`;
  const row: InstrumentRow = {
    id: `${ticker}:bstocks`,
    ticker,
    issuer: 'bstocks',
    platformId: 'bstock',
    chainId: 56,
    address: randomAddress(),
    symbol: `${ticker}B`,
    decimals: 18,
    assetType: 1,
    multiplier: '1.000778223752807865',
    multiplierSource: 'onchain',
    apiShareRatio: '1.000778223752807865',
    verifiedAt: '2026-09-24T00:45:40.000Z',
  };
  await upsertInstruments(db, [row]);
  return row;
}

/** One tape run for `instrument` at `sampledAt`: quotes of $5/$50/$500, TRADING, a US price. */
export async function writeTape(
  db: Db,
  instrument: InstrumentRow,
  sampledAt: string,
  overrides: Partial<TapeSampleInsert> = {},
): Promise<void> {
  await insertTapeSamples(
    db,
    [5, 50, 500].map((sizeUsd) => ({
      sampledAt,
      slotAt: sampledAt,
      instrumentId: instrument.id,
      session: 'regular',
      openState: true,
      marketStatus: null,
      reasonCode: 'TRADING',
      reasonMsg: null,
      nextOpenTime: null,
      tokenPrice: '225.175',
      referencePrice: '225.1',
      stockPrice: '225',
      priceUpdatedAt: sampledAt,
      sizeUsd,
      expectedOut: (TOKENS_PER_USD * BigInt(sizeUsd)).toString(),
      priceImpactPct: '0.05',
      vendor: 'test',
      executionMode: 'SWAP',
      route: null,
      errorCode: null,
      errorMsg: null,
      latencyMs: 120,
      ...overrides,
    })),
  );
}

export async function addJudgeCodes(db: Db, codes: readonly string[]): Promise<void> {
  await db
    .insert(judgeCodes)
    .values(codes.map((code) => ({ codeHash: sha256Hex(code), label: 'web-test' })));
}

/** Deletes what a test file created; foreign keys never cascade. */
export async function cleanup(
  db: Db,
  created: {
    planIds?: readonly string[];
    instrumentIds?: readonly string[];
    judgeCodes?: readonly string[];
    tokenIds?: readonly string[];
  },
): Promise<void> {
  const planIds = [...(created.planIds ?? [])];
  if (planIds.length > 0) {
    await db.delete(jobs).where(inArray(jobs.planId, planIds));
    await db.delete(txOutbox).where(inArray(txOutbox.planId, planIds));
    await db.delete(spendLedger).where(inArray(spendLedger.planId, planIds));
    await db.delete(receipts).where(inArray(receipts.planId, planIds));
    await db.delete(holdings).where(inArray(holdings.planId, planIds));
    await db.delete(guardianEvents).where(inArray(guardianEvents.planId, planIds));
    await db.delete(cycles).where(inArray(cycles.planId, planIds));
    await db.delete(plans).where(inArray(plans.id, planIds));
  }
  const instrumentIds = [...(created.instrumentIds ?? [])];
  if (instrumentIds.length > 0) {
    await db.delete(tapeSamples).where(inArray(tapeSamples.instrumentId, instrumentIds));
    await db.delete(instruments).where(inArray(instruments.id, instrumentIds));
  }
  const codes = (created.judgeCodes ?? []).map(sha256Hex);
  if (codes.length > 0) await db.delete(judgeCodes).where(inArray(judgeCodes.codeHash, codes));
  const tokenIds = [...(created.tokenIds ?? [])];
  if (tokenIds.length > 0) await db.delete(skillTokens).where(inArray(skillTokens.id, tokenIds));
}
