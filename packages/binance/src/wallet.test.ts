/** Wallet API reads (DECISIONS D-34): what is sent, and how each documented answer is read. */
import { describe, expect, it } from 'vitest';
import { BinanceClient } from './client.js';
import { RateLimiter, type Clock } from './rate-limit.js';
import {
  getTokenBalances,
  getTransactionDetail,
  parseTokenBalances,
  parseTransactionDetail,
} from './wallet.js';

const HOUSE = '0x1111111111111111111111111111111111111111';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const HASH = `0x${'ab'.repeat(32)}`;

function clock(): Clock {
  let now = Date.parse('2026-10-03T04:00:00.000Z');
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

/** A client that answers every request with `data`, and remembers what it was sent. */
function client(data: unknown) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  const c = clock();
  return {
    sent,
    client: new BinanceClient({
      baseUrl: 'https://web3.binance.com/build',
      apiKey: 'k',
      apiSecret: 's',
      clock: c,
      limiter: new RateLimiter(undefined, c),
      fetch: (input, init) => {
        sent.push({
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        });
        return Promise.resolve(
          new Response(JSON.stringify({ code: 0, msg: 'success', data, success: true }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    }),
  };
}

describe('parseTransactionDetail', () => {
  it('reads the documented status, fee, height and gas', () => {
    expect(
      parseTransactionDetail([
        {
          chainIndex: '56',
          txhash: HASH,
          txStatus: 'success',
          txFee: '0.000046079',
          height: '125306973',
          gasUsed: '767983',
        },
      ]),
    ).toEqual({
      txStatus: 'success',
      txFee: '0.000046079',
      height: '125306973',
      gasUsed: '767983',
    });
    expect(parseTransactionDetail([{ txStatus: 'pending', gasUsed: null }])).toEqual({
      txStatus: 'pending',
      txFee: null,
      height: null,
      gasUsed: null,
    });
  });

  it('reads an empty list as not indexed yet (the docs: indexing may lag the broadcast)', () => {
    expect(parseTransactionDetail([])).toBeNull();
    expect(parseTransactionDetail(null)).toBeNull();
  });

  it('refuses a shape or a status the docs do not have', () => {
    expect(() => parseTransactionDetail({ txStatus: 'success' })).toThrow(/not a list/);
    expect(() => parseTransactionDetail(['x'])).toThrow(/not an object/);
    expect(() => parseTransactionDetail([{ txStatus: 'confirmed' }])).toThrow(
      /"confirmed" is not success, fail or pending/,
    );
  });
});

describe('parseTokenBalances', () => {
  it('flattens the per-chain tokenAssets, raw units as integers only', () => {
    expect(
      parseTokenBalances([
        {
          tokenAssets: [
            {
              binanceChainId: '56',
              tokenContractAddress: USDT,
              symbol: 'USDT',
              balance: '3.5',
              rawBalance: '3500000000000000000',
            },
            { tokenContractAddress: '', symbol: 'BNB', balance: '0.005', rawBalance: '' },
          ],
        },
      ]),
    ).toEqual([
      {
        tokenContractAddress: USDT,
        symbol: 'USDT',
        rawBalance: '3500000000000000000',
        balance: '3.5',
      },
      { tokenContractAddress: '', symbol: 'BNB', rawBalance: null, balance: '0.005' },
    ]);
    expect(parseTokenBalances([{}])).toEqual([]);
  });

  it('refuses a shape it cannot read', () => {
    expect(() => parseTokenBalances({ tokenAssets: [] })).toThrow(/not a list/);
    expect(() => parseTokenBalances([{ tokenAssets: {} }])).toThrow(/tokenAssets is not a list/);
  });
});

describe('the requests', () => {
  it('asks for the detail of one BSC transaction by hash (Step 6)', async () => {
    const { client: c, sent } = client([{ txStatus: 'fail', txFee: '0.00001' }]);
    expect(await getTransactionDetail(c, HASH)).toMatchObject({ txStatus: 'fail' });
    const url = new URL(sent[0]?.url ?? '');
    expect(sent[0]?.method).toBe('GET');
    expect(url.pathname).toBe('/build/api/v1/dex/post-transaction/transaction-detail-by-txhash');
    expect(Object.fromEntries(url.searchParams)).toEqual({ binanceChainId: '56', txHash: HASH });
  });

  it('asks for exactly the listed tokens on BSC, BNB as the empty address', async () => {
    const { client: c, sent } = client([{ tokenAssets: [] }]);
    expect(await getTokenBalances(c, { address: HOUSE, tokens: [USDT, ''] })).toEqual([]);
    expect(sent[0]?.method).toBe('POST');
    expect(new URL(sent[0]?.url ?? '').pathname).toBe(
      '/build/api/v1/dex/balance/token-balances-by-address',
    );
    expect(sent[0]?.body).toEqual({
      address: HOUSE,
      tokenContractAddresses: [
        { binanceChainId: '56', tokenContractAddress: USDT },
        { binanceChainId: '56', tokenContractAddress: '' },
      ],
    });
    await expect(getTokenBalances(c, { address: HOUSE, tokens: [] })).rejects.toThrow(/1 to 20/);
  });
});
