/**
 * Test doubles for the cycle runner: a Binance Web3 API that answers from scripted handlers
 * (shapes copied from fixtures/), and an in-memory chain that "mines" signed transactions by
 * decoding them. The signer is Hardhat's public test key #0 — known to everyone, never funded by
 * us, and nothing here touches a network.
 */
import { BinanceClient, RateLimiter, type Clock } from '@ijaro/binance';
import { BSC_USDT, decodeApprove } from '@ijaro/chain';
import {
  cycles,
  guardianEvents,
  holdings,
  instruments,
  jobs,
  plans,
  receipts,
  spendLedger,
  txOutbox,
  type Db,
} from '@ijaro/db';
import { inArray } from 'drizzle-orm';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  type Hex,
  type Log,
} from 'viem';
import type { ChainPort, ReceiptLike } from '../src/executor/chain-port.js';
import { houseSigner } from '../src/executor/signer.js';

export const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const signer = houseSigner(TEST_KEY);
export const HOUSE = signer.address;
export const ROUTER = getAddress('0xb44446b0c8e56988c34f7ff73ae904982b5fdda5');
export const TOKEN = getAddress('0x00000000000000000000000000000000000000b1');

export function testClock(startIso: string): Clock & { advance(ms: number): void } {
  let now = Date.parse(startIso);
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

const transferEvent = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export function transferLog(token: string, from: string, to: string, value: bigint): Log {
  return {
    address: getAddress(token),
    topics: encodeEventTopics({
      abi: transferEvent,
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

export interface MinedTx {
  to: string;
  data: Hex;
  nonce: number;
}

export interface FakeChain extends ChainPort {
  allowances: Map<string, bigint>;
  sent: MinedTx[];
  /** What mining a transaction does: its status and logs (default: success, no logs). */
  onMine: (tx: MinedTx) => { status: 'success' | 'reverted'; logs: Log[] };
  /** When false, receipts never arrive (the wait times out). */
  mines: boolean;
  accept(raw: Hex): Hex;
}

const allowanceKey = (token: string, owner: string, spender: string) =>
  `${token}:${owner}:${spender}`.toLowerCase();

/** `startNonce`: the house wallet's next nonce (tests share one database and one test key). */
export function fakeChain(startNonce = 0): FakeChain {
  const mempool = new Map<Hex, MinedTx>();
  const mined = new Map<Hex, ReceiptLike>();
  let minedNonce = startNonce;
  let block = 123_700_000n;
  const chain: FakeChain = {
    allowances: new Map(),
    sent: [],
    mines: true,
    onMine: () => ({ status: 'success', logs: [] }),
    accept(raw) {
      const tx = parseTransaction(raw);
      const hash = keccak256(raw);
      const entry = { to: tx.to ?? '', data: tx.data ?? '0x', nonce: tx.nonce ?? -1 };
      if (!mempool.has(hash) && !mined.has(hash)) {
        mempool.set(hash, entry);
        chain.sent.push(entry);
      }
      return hash;
    },
    allowance: (token, owner, spender) =>
      Promise.resolve(chain.allowances.get(allowanceKey(token, owner, spender)) ?? 0n),
    balanceOf: () => Promise.resolve(10n ** 21n),
    exchangeRate: () => Promise.resolve(10n ** 28n),
    underlyingOf: () => Promise.resolve(BSC_USDT),
    pendingNonce: () => Promise.resolve(minedNonce + mempool.size),
    minedNonce: () => Promise.resolve(minedNonce),
    sendRaw: (raw) => Promise.resolve(chain.accept(raw)),
    waitForReceipt(hash) {
      const tx = mempool.get(hash);
      if (!tx || !chain.mines) return Promise.resolve(mined.get(hash));
      mempool.delete(hash);
      minedNonce += 1;
      block += 1n;
      if (tx.data.startsWith('0x095ea7b3')) {
        const { spender, amount } = decodeApprove(tx.data);
        chain.allowances.set(allowanceKey(tx.to, HOUSE, spender), amount);
      }
      const effect = chain.onMine(tx);
      const receipt: ReceiptLike = {
        status: effect.status,
        blockNumber: block,
        gasUsed: 50_000n,
        effectiveGasPrice: 58_339_710n,
        logs: effect.logs,
      };
      mined.set(hash, receipt);
      return Promise.resolve(receipt);
    },
    receipt: (hash) => Promise.resolve(mined.get(hash)),
  };
  return chain;
}

type Handler = (url: URL, body: unknown) => unknown;

export interface FakeApi {
  client: BinanceClient;
  calls: string[];
  routes: Record<string, Handler>;
}

/** A BinanceClient whose requests are answered by `routes` (path → data, or {code, msg}). */
export function fakeApi(clock: Clock, routes: Record<string, Handler>): FakeApi {
  const calls: string[] = [];
  const api: FakeApi = {
    calls,
    routes,
    client: new BinanceClient({
      baseUrl: 'https://web3.binance.com/build',
      apiKey: 'k',
      apiSecret: 's',
      clock,
      limiter: new RateLimiter(undefined, clock),
      fetch: (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const path = url.pathname.replace(/^\/build/, '');
        calls.push(path);
        const handler = api.routes[path];
        if (!handler)
          return Promise.resolve(
            Response.json({ code: 40001, msg: `no fake for ${path}`, data: null }),
          );
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
        const result = handler(url, body);
        if (result && typeof result === 'object' && 'code' in result && 'msg' in result) {
          return Promise.resolve(Response.json({ ...result, data: null, success: false }));
        }
        return Promise.resolve(
          Response.json({ code: 0, msg: 'success', data: result, success: true }),
        );
      },
    }),
  };
  return api;
}

/** Removes test plans and everything that references them, and the test instrument. */
export async function cleanup(
  db: Db,
  planIds: readonly string[],
  instrumentIds: readonly string[],
) {
  const ids = [...planIds];
  if (ids.length > 0) {
    await db.delete(jobs).where(inArray(jobs.planId, ids));
    await db.delete(txOutbox).where(inArray(txOutbox.planId, ids));
    await db.delete(spendLedger).where(inArray(spendLedger.planId, ids));
    await db.delete(receipts).where(inArray(receipts.planId, ids));
    await db.delete(holdings).where(inArray(holdings.planId, ids));
    await db.delete(guardianEvents).where(inArray(guardianEvents.planId, ids));
    await db.delete(cycles).where(inArray(cycles.planId, ids));
    await db.delete(plans).where(inArray(plans.id, ids));
  }
  if (instrumentIds.length > 0)
    await db.delete(instruments).where(inArray(instruments.id, [...instrumentIds]));
}
