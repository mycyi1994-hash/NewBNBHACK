/**
 * Wallet API (DECISIONS D-34): the two reads the worker makes beside the chain — the status of a
 * broadcast transaction (`transaction-detail-by-txhash`, the official integration flow's Step 6)
 * and the balances of the house address (`token-balances-by-address`). Field names and meanings
 * are the connector's (`@binance-web3/wallet` 12.3.0, `GetTransactionDetailByHashResponseDataInner`,
 * `GetTokenBalancesByAddressResponseDataInnerTokenAssetsInner`) and the docs' (llms-full.txt
 * § Wallet API, § Step 6). Answers are validated: an unexpected shape throws, it never reads as a
 * success or as a zero.
 */
import type { BinanceClient } from './client.js';
import { BSC } from './endpoints.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown) =>
  typeof value === 'string' && value !== ''
    ? value
    : typeof value === 'number' || typeof value === 'bigint'
      ? value.toString()
      : null;

/** The three statuses the docs list (Step 6): pending, success, fail. */
export type IndexedTxStatus = 'success' | 'fail' | 'pending';

export interface IndexedTransaction {
  txStatus: IndexedTxStatus;
  /** Fee in the chain's native token (BNB), as a decimal string. */
  txFee: string | null;
  height: string | null;
  gasUsed: string | null;
}

/**
 * `data` of transaction-detail-by-txhash: null while the transaction is not indexed yet (the docs:
 * "may return an empty data array while indexing catches up"), else its first entry.
 */
export function parseTransactionDetail(data: unknown): IndexedTransaction | null {
  if (data === null || data === undefined) return null;
  if (!Array.isArray(data)) throw new Error('transaction detail: data is not a list');
  const [first] = data as unknown[];
  if (first === undefined) return null;
  if (!isRecord(first)) throw new Error('transaction detail: entry is not an object');
  const status = first.txStatus;
  if (status !== 'success' && status !== 'fail' && status !== 'pending') {
    throw new Error(
      `transaction detail: txStatus ${JSON.stringify(status)} is not success, fail or pending`,
    );
  }
  return {
    txStatus: status,
    txFee: text(first.txFee),
    height: text(first.height),
    gasUsed: text(first.gasUsed),
  };
}

/** Step 6: Binance's indexed status of a BSC transaction; null while it is not indexed yet. */
export async function getTransactionDetail(
  client: BinanceClient,
  txHash: string,
): Promise<IndexedTransaction | null> {
  const res = await client.request<unknown>('wallet', 'getTransactionDetailByHash', {
    method: 'GET',
    path: '/api/v1/dex/post-transaction/transaction-detail-by-txhash',
    query: { binanceChainId: BSC, txHash },
    retries: 2,
  });
  return parseTransactionDetail(res.data);
}

export interface WalletTokenBalance {
  /** The token contract; '' for the chain's native asset (BNB). */
  tokenContractAddress: string;
  symbol: string | null;
  /** Smallest units as an integer string; null when the API gives none. */
  rawBalance: string | null;
  /** The amount scaled by decimals, as the API wrote it. */
  balance: string | null;
}

/** `data` of token-balances-by-address: one entry per chain asked, each with its tokenAssets. */
export function parseTokenBalances(data: unknown): WalletTokenBalance[] {
  if (!Array.isArray(data)) throw new Error('token balances: data is not a list');
  return (data as unknown[]).flatMap((entry) => {
    if (!isRecord(entry)) throw new Error('token balances: entry is not an object');
    const assets = entry.tokenAssets;
    if (assets !== undefined && !Array.isArray(assets)) {
      throw new Error('token balances: tokenAssets is not a list');
    }
    return ((assets ?? []) as unknown[]).filter(isRecord).map((asset) => {
      const raw = text(asset.rawBalance);
      return {
        tokenContractAddress:
          typeof asset.tokenContractAddress === 'string' ? asset.tokenContractAddress : '',
        symbol: text(asset.symbol),
        rawBalance: raw !== null && /^\d+$/.test(raw) ? raw : null,
        balance: text(asset.balance),
      };
    });
  });
}

/** The balances of `address` for these BSC tokens ('' is BNB); the API takes up to 20. */
export async function getTokenBalances(
  client: BinanceClient,
  params: { address: string; tokens: readonly string[] },
): Promise<WalletTokenBalance[]> {
  if (params.tokens.length === 0 || params.tokens.length > 20) {
    throw new Error(`token balances: 1 to 20 tokens, not ${params.tokens.length}`);
  }
  const res = await client.request<unknown>('wallet', 'getTokenBalancesByAddress', {
    method: 'POST',
    path: '/api/v1/dex/balance/token-balances-by-address',
    body: {
      address: params.address,
      tokenContractAddresses: params.tokens.map((token) => ({
        binanceChainId: BSC,
        tokenContractAddress: token,
      })),
    },
    retries: 1,
  });
  return parseTokenBalances(res.data);
}
