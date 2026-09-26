/**
 * Typed wrappers for the calls a cycle makes (SPEC §5.6–§5.8; flow: llms-full.txt § Integration
 * Flow (Trading API) and (DeFi API)). Field names come from the docs and from recorded responses
 * under fixtures/. Nothing here signs: signing happens in the worker, with the house key only.
 * Idempotent calls retry transient failures (SPEC §11); the broadcast never does — the executor
 * falls back to RPC with the same signed bytes instead.
 */
import type { BinanceClient } from './client.js';
import { parseSimulation, type SimulationResult } from './simulation.js';

export const BSC = '56';

/** One route of GET /quote (fixtures/trading/getAggregatedQuote-*.json). */
export interface QuoteRoute {
  quoteId: string;
  vendorName?: string;
  executionMode?: string;
  fromTokenAmount?: string;
  /** Tokens out, base units. */
  toTokenAmount?: string;
  priceImpactPercent?: string;
  /** Informational spender of the route; cross-checked against /approve-transaction. */
  approveTarget?: string | null;
  isBest?: boolean;
}

/** GET /approve-transaction item: ERC-20 approve() calldata and its spender. */
export interface ApproveTransaction {
  data: string;
  dexContractAddress: string;
  gasLimit?: string;
  gasPrice?: string;
}

/** Unsigned EVM transaction under GET /swap `data.tx` (fixtures/trading/buildSwapTransaction-*). */
export interface SwapTx {
  from: string;
  to: string;
  data: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string | null;
  /** Slippage floor of the route, base units. */
  minReceiveAmount?: string | null;
}

export interface SwapBuild {
  tx: SwapTx;
  executionMode?: string;
  rfq?: unknown;
}

export interface EvmCall {
  from: string;
  to: string;
  value: string;
  data: string;
}

/** DeFi build item (fixtures/defi-transaction/*): APPROVE, DEPOSIT or REDEEM, in order. */
export interface DeFiCall {
  callDataType: string;
  from: string;
  to: string;
  value?: string;
  data: string;
  gasLimit?: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
  maxFeePerGas?: string;
}

export interface DeFiBuild {
  dataList: DeFiCall[];
  /** [min, max] days; [] or absent means instant. */
  redeemDelayDays?: number[] | null;
}

/** GET /transaction-detail-by-txhash item (§ Integration Flow (Trading API) › Step 6). */
export interface TransactionDetail {
  txhash?: string;
  txStatus?: string;
  height?: string;
  gasUsed?: string;
  txFee?: string;
  tokenTransferDetails?: unknown[];
}

/** Quote routes for `amount` base units of `fromToken`; the best route first. */
export async function getQuote(
  client: BinanceClient,
  params: { fromToken: string; toToken: string; amount: bigint; userWalletAddress?: string },
): Promise<{ routes: QuoteRoute[]; latencyMs: number }> {
  const res = await client.request<QuoteRoute[]>('trading', 'getAggregatedQuote', {
    method: 'GET',
    path: '/api/v1/dex/aggregator/quote',
    query: {
      binanceChainId: BSC,
      amount: params.amount.toString(),
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      ...(params.userWalletAddress ? { userWalletAddress: params.userWalletAddress } : {}),
    },
    retries: 2,
  });
  const routes = [...res.data].sort(
    (a, b) => Number(b.isBest ?? false) - Number(a.isBest ?? false),
  );
  return { routes, latencyMs: res.latencyMs };
}

/** ERC-20 approve() calldata for exactly `amount` base units of `token` (Step 1). */
export async function getApproveTransaction(
  client: BinanceClient,
  params: { token: string; amount: bigint },
): Promise<ApproveTransaction> {
  const res = await client.request<ApproveTransaction[]>('trading', 'getErc20ApproveTransaction', {
    method: 'GET',
    path: '/api/v1/dex/aggregator/approve-transaction',
    query: {
      binanceChainId: BSC,
      tokenContractAddress: params.token,
      approveAmount: params.amount.toString(),
    },
    retries: 2,
  });
  const [first] = res.data;
  if (!first) throw new Error('approve-transaction returned no item');
  return first;
}

/** The unsigned swap for a quote (Step 3). Parameters must match the quote exactly (40462). */
export async function buildSwap(
  client: BinanceClient,
  params: {
    quoteId: string;
    fromToken: string;
    toToken: string;
    amount: bigint;
    userWalletAddress: string;
    slippagePercent: string;
  },
): Promise<SwapBuild> {
  const res = await client.request<SwapBuild>('trading', 'buildSwapTransaction', {
    method: 'GET',
    path: '/api/v1/dex/aggregator/swap',
    query: {
      binanceChainId: BSC,
      amount: params.amount.toString(),
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      userWalletAddress: params.userWalletAddress,
      quoteId: params.quoteId,
      slippagePercent: params.slippagePercent,
    },
    retries: 1,
  });
  return res.data;
}

/** Transaction API simulation of one call; the caller decides on `status` (Q-14). */
export async function simulateCall(
  client: BinanceClient,
  call: EvmCall,
): Promise<SimulationResult> {
  const res = await client.request<unknown>('transaction', 'simulateTransactions', {
    method: 'POST',
    path: '/api/v1/dex/pre-transaction/simulate',
    body: { binanceChainId: BSC, evmTx: call },
    retries: 2,
  });
  return parseSimulation(res.data);
}

/** Transaction API gas estimate for one call (base units of gas). */
export async function estimateGasLimit(client: BinanceClient, call: EvmCall): Promise<bigint> {
  const res = await client.request<{ gasLimit?: string }>('transaction', 'getGasLimit', {
    method: 'POST',
    path: '/api/v1/dex/pre-transaction/gas-limit',
    body: { binanceChainId: BSC, evmTx: call },
    retries: 2,
  });
  if (!res.data.gasLimit) throw new Error('gas-limit returned no gasLimit');
  return BigInt(res.data.gasLimit);
}

/** Broadcasts signed bytes once (Step 5). No retry here: the executor owns the fallback. */
export async function broadcastSigned(
  client: BinanceClient,
  params: { address: string; signedTransaction: string },
): Promise<{ txHash: string; orderId: string | null }> {
  const res = await client.request<{ txHash?: string; orderId?: string }>(
    'transaction',
    'broadcastTransactions',
    {
      method: 'POST',
      path: '/api/v1/dex/pre-transaction/broadcast-transaction',
      body: {
        binanceChainId: BSC,
        address: params.address,
        signedTransaction: params.signedTransaction,
        enableMevProtection: false,
      },
    },
  );
  if (!res.data.txHash) throw new Error('broadcast returned no txHash');
  return { txHash: res.data.txHash, orderId: res.data.orderId ?? null };
}

/** Indexed status of a transaction; undefined while it is not indexed yet (Step 6). */
export async function getTransactionDetail(
  client: BinanceClient,
  txHash: string,
): Promise<TransactionDetail | undefined> {
  const res = await client.request<TransactionDetail[]>('wallet', 'getTransactionDetailByHash', {
    method: 'GET',
    path: '/api/v1/dex/post-transaction/transaction-detail-by-txhash',
    query: { binanceChainId: BSC, txHash },
    retries: 2,
  });
  return res.data[0];
}

/**
 * DeFi deposit or redeem calldata. `amount` is human-readable (DeFi convention: "10" = 10 USDT,
 * llms-full.txt § DeFi Introduction › Data Format Conventions). `simulate=false`: the preview
 * rejects wallets without balance or position (40484, Q-05); we simulate each call ourselves.
 */
export async function buildDeFi(
  client: BinanceClient,
  action: 'deposit' | 'redeem',
  params: { address: string; investmentId: string; tokenAddress: string; amount: string },
): Promise<DeFiBuild> {
  const res = await client.request<DeFiBuild>(
    'defi-transaction',
    action === 'deposit' ? 'buildDeFiDepositTransaction' : 'buildDeFiRedeemTransaction',
    {
      method: 'POST',
      path: `/api/v1/defi/transaction/${action}`,
      body: {
        address: params.address,
        investmentId: params.investmentId,
        token: { tokenAddress: params.tokenAddress, amount: params.amount },
        simulate: false,
      },
      retries: 1,
    },
  );
  return res.data;
}

/** A DeFi investment (POST /defi/data/investment/list; fixtures/defi-data/listDeFiInvestments-*). */
export interface DeFiInvestment {
  investmentId: string;
  investmentName?: string;
  investType?: string;
  investable?: boolean;
  apyBps?: number;
  assetTokenList?: { tokenAddress?: string; tokenSymbol?: string }[];
}

export async function listDeFiInvestments(
  client: BinanceClient,
  filter: { defiProtocolId: string; investType: string; tokenAddress: string },
): Promise<DeFiInvestment[]> {
  const res = await client.request<{ list?: DeFiInvestment[] }>(
    'defi-data',
    'listDeFiInvestments',
    {
      method: 'POST',
      path: '/api/v1/defi/data/investment/list',
      body: {
        investType: filter.investType,
        defiProtocolId: filter.defiProtocolId,
        binanceChainId: BSC,
        tokenAddressList: [filter.tokenAddress],
        page: 1,
        size: 20,
      },
      retries: 2,
    },
  );
  return res.data.list ?? [];
}

/** An RWA token price row (GET /rwa/price). */
export interface RwaPrice {
  tokenContractAddress: string;
  tokenPrice: string | null;
  referencePrice: string | null;
  tokenPriceUpdatedAt: number | null;
}

export async function getRwaPrices(
  client: BinanceClient,
  addresses: readonly string[],
): Promise<RwaPrice[]> {
  const res = await client.request<RwaPrice[]>('rwa', 'getRwaTokenPrice', {
    method: 'GET',
    path: '/api/v1/dex/market/rwa/price',
    query: { binanceChainId: BSC, tokenContractAddresses: addresses.join(',') },
    retries: 2,
  });
  return res.data;
}

/** POST /market/price (body shape measured, DECISIONS V-09): current USD prices of tokens. */
export async function getTokenPrices(
  client: BinanceClient,
  addresses: readonly string[],
): Promise<{ tokenContractAddress: string; price: string | null }[]> {
  const res = await client.request<{ tokenContractAddress: string; price?: string | null }[]>(
    'market',
    'getTokenPrice',
    {
      method: 'POST',
      path: '/api/v1/dex/market/price',
      body: addresses.map((tokenContractAddress) => ({
        binanceChainId: BSC,
        tokenContractAddress,
      })),
      retries: 2,
    },
  );
  return res.data.map((p) => ({
    tokenContractAddress: p.tokenContractAddress,
    price: p.price ?? null,
  }));
}

/** POST /defi/data/protocol/detail: the protocol's TVL (USD, as text) among other facts. */
/** Protocol TVL and the platform's security score (fixtures/defi-data/getProtocolDetail-*). */
export async function getProtocolSummary(
  client: BinanceClient,
  defiProtocolId: string,
): Promise<{ tvl: string | null; securityScore: string | null }> {
  const res = await client.request<{ tvl?: string | null; securityScore?: string | null }>(
    'defi-data',
    'getProtocolDetail',
    {
      method: 'POST',
      path: '/api/v1/defi/data/protocol/detail',
      body: { defiProtocolId },
      retries: 2,
    },
  );
  return { tvl: res.data.tvl ?? null, securityScore: res.data.securityScore ?? null };
}
