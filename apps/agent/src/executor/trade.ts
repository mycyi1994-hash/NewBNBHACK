/**
 * The buy path (SPEC §5.8 v2; llms-full.txt § Integration Flow (Trading API)):
 *   exact approve (verified calldata) → approval receipt → fresh quote → swap calldata (verified)
 *   → simulation SUCCESS → sign → outbox → broadcast → receipt → amounts from the logs.
 * In `simulate` mode every call up to the simulation is real and nothing is signed. What the API
 * hands us is decoded and checked before anything is signed: an approval must be for exactly the
 * spend and for the spender the API names, a swap must come from the house wallet, carry no BNB,
 * and pass its simulation.
 */
import {
  BinanceApiError,
  buildSwap,
  estimateGasLimit,
  getApproveTransaction,
  simulateCall,
  type BinanceClient,
  type QuoteRoute,
  type SimulationResult,
} from '@yieldvest/binance';
import { apiInt, BSC_USDT, decodeApprove, transferredFrom, transferredTo } from '@yieldvest/chain';
import { MAX_QUOTE_AGE_MS, type Instrument, type QuoteObservation } from '@yieldvest/core';
import type { Db } from '@yieldvest/db';
import { isAddressEqual, type Hex } from 'viem';
import type { ChainPort, ReceiptLike } from './chain-port.js';
import { sendTransaction, type SendDeps, type SendResult } from './send.js';
import type { Signer } from './signer.js';

/** Slippage for /swap (the tape and G1 used 0.5 %); the quote-impact rule sits in decideCycle. */
export const SLIPPAGE_PERCENT = '0.5';

export interface TradeDeps {
  mode: 'simulate' | 'live';
  client: BinanceClient;
  chain: ChainPort;
  db: Db;
  /** The house wallet: the sender of every transaction. */
  house: Hex;
  /** Required in live mode; never used in simulate mode. */
  signer?: Signer;
  log: (line: string) => void;
  now: () => Date;
  /** Runs before anything is signed and may refuse by throwing (a cycle renews its plan lock). */
  beforeSign?: () => Promise<void>;
  /** Waits between simulations (simulateAfterApproval); real time when absent. */
  sleep?: (ms: number) => Promise<void>;
}

/** A simulation that reverted for want of an allowance. */
const ALLOWANCE_REVERT = /allowance/i;
/** Simulations after the first, and the wait before each (PD-07). */
const RESIMULATIONS = 2;
const RESIMULATE_AFTER_MS = 1_500;

/**
 * Runs a simulation; when an approval was mined moments ago in this same run and the simulation
 * reverts for want of that allowance, runs it again — twice, 1.5 s apart. Our RPC answers with the
 * approval's receipt as soon as it holds the block, and the Transaction API may simulate on a node
 * a block behind it (PD-07). Nothing is signed until a simulation passes; any other result stands.
 */
export async function simulateAfterApproval(
  deps: Pick<TradeDeps, 'log' | 'sleep'>,
  justApproved: boolean,
  run: () => Promise<SimulationResult>,
): Promise<SimulationResult> {
  let result = await run();
  for (let attempt = 1; attempt <= RESIMULATIONS; attempt++) {
    if (!justApproved || result.status === 'SUCCESS') break;
    if (!ALLOWANCE_REVERT.test(result.failReason ?? '')) break;
    deps.log(
      `simulate: "${result.failReason}" right after our approval was mined — again in ${RESIMULATE_AFTER_MS / 1000} s`,
    );
    await (deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(
      RESIMULATE_AFTER_MS,
    );
    result = await run();
  }
  return result;
}

export type Failure = {
  kind: 'failed';
  code: string;
  message: string;
  fundsMoved: 'none' | 'gas_only';
};

/** A transaction that went on chain, for the receipts table. */
export interface SentTx {
  kind: 'approve' | 'swap' | 'deposit' | 'redeem';
  txHash: Hex;
  broadcastVia: string;
  receipt: ReceiptLike;
  simulatedAt: string;
  amounts: Record<string, string>;
}

export type ApprovalResult =
  | {
      kind: 'ready';
      spender: Hex;
      /** How the allowance got there. */
      via: 'existing_allowance' | 'simulated' | 'sent';
      simulation?: SimulationResult;
      sent?: SentTx;
    }
  | { kind: 'pending'; txHash: Hex }
  | Failure;

export type SwapResult =
  /** The quote went stale or its route vanished: quote again. */
  | { kind: 'requote'; reason: string }
  | {
      kind: 'simulated';
      simulation: SimulationResult;
      router: string;
      minReceive: string | null;
    }
  | { kind: 'bought'; receivedTokens: bigint; spentUnits: bigint; sent: SentTx }
  | { kind: 'pending'; txHash: Hex }
  /** Confirmed, but the logs do not show the tokens: a human must look before anything else. */
  | { kind: 'anomaly'; message: string; sent: SentTx }
  | Failure;

const fail = (
  code: string,
  message: string,
  fundsMoved: 'none' | 'gas_only' = 'none',
): Failure => ({
  kind: 'failed',
  code,
  message,
  fundsMoved,
});

function apiFailure(step: string, error: BinanceApiError): Failure {
  return fail(String(error.code ?? error.kind), `${step}: ${error.msg}`);
}

function requireSigner(deps: TradeDeps): Signer {
  if (deps.mode !== 'live' || !deps.signer) throw new Error('live mode with a signer is required');
  if (!isAddressEqual(deps.signer.address, deps.house))
    throw new Error('signer is not the house wallet');
  return deps.signer;
}

/** What sendTransaction needs from the trade deps (live mode, the house signer). */
export function sendDeps(deps: TradeDeps): SendDeps {
  return {
    client: deps.client,
    chain: deps.chain,
    db: deps.db,
    signer: requireSigner(deps),
    log: deps.log,
    ...(deps.beforeSign ? { beforeSign: deps.beforeSign } : {}),
  };
}

/** Maps a send result for one transaction; `confirmed` yields the SentTx. */
function sentOrFailure(
  result: SendResult,
  kind: SentTx['kind'],
  simulatedAt: string,
  amounts: Record<string, string>,
): SentTx | { kind: 'pending'; txHash: Hex } | Failure {
  switch (result.state) {
    case 'confirmed':
      return {
        kind,
        txHash: result.txHash,
        broadcastVia: result.broadcastVia,
        receipt: result.receipt,
        simulatedAt,
        amounts,
      };
    case 'pending':
      return { kind: 'pending', txHash: result.txHash };
    case 'reverted':
      return fail(
        `${kind.toUpperCase()}_REVERTED`,
        `${kind} ${result.txHash} reverted on chain`,
        'gas_only',
      );
    case 'not_sent':
      return fail(`${kind.toUpperCase()}_NOT_SENT`, result.reason);
  }
}

/**
 * Makes sure the Trading API spender may pull exactly `amount` of `token` from the house wallet.
 * Docs Step 1: the approval comes before the quote; an existing allowance that covers the amount
 * (left from an earlier exact approval) is used as it is.
 */
export async function ensureApproval(
  deps: TradeDeps,
  args: { planId: string; cycleId: number; token?: string; amount: bigint },
): Promise<ApprovalResult> {
  const token = args.token ?? BSC_USDT;
  let approval;
  try {
    approval = await getApproveTransaction(deps.client, { token, amount: args.amount });
  } catch (error) {
    if (error instanceof BinanceApiError) return apiFailure('approve-transaction', error);
    throw error;
  }
  const decoded = decodeApprove(approval.data);
  if (!isAddressEqual(decoded.spender, approval.dexContractAddress as Hex)) {
    return fail(
      'APPROVE_SPENDER_MISMATCH',
      `calldata spender ${decoded.spender} ≠ ${approval.dexContractAddress}`,
    );
  }
  if (decoded.amount !== args.amount) {
    // Never sign more than the spend (CLAUDE.md rule 5): an unlimited approval stops here.
    return fail(
      'APPROVE_NOT_EXACT',
      `approve-transaction asks for ${decoded.amount}, the spend is ${args.amount}`,
    );
  }
  const spender = decoded.spender;
  const allowance = await deps.chain.allowance(token, deps.house, spender);
  if (allowance >= args.amount) {
    deps.log(`approve: allowance ${allowance} already covers ${args.amount}`);
    return { kind: 'ready', spender, via: 'existing_allowance' };
  }

  const call = { from: deps.house, to: token, value: '0', data: approval.data };
  let simulation: SimulationResult;
  try {
    simulation = await simulateCall(deps.client, call);
  } catch (error) {
    if (error instanceof BinanceApiError) return apiFailure('simulate approve', error);
    throw error;
  }
  const simulatedAt = deps.now().toISOString();
  if (simulation.status !== 'SUCCESS') {
    return fail('SIM_APPROVE', `approve simulation ${simulation.status}: ${simulation.failReason}`);
  }
  if (deps.mode === 'simulate') return { kind: 'ready', spender, via: 'simulated', simulation };

  const gas = approval.gasLimit
    ? apiInt(approval.gasLimit, 'approve gasLimit')
    : await estimateGasLimit(deps.client, call);
  const result = await sendTransaction(sendDeps(deps), {
    planId: args.planId,
    cycleId: args.cycleId,
    kind: 'approve',
    to: token,
    data: approval.data,
    value: 0n,
    gas,
    gasPrice: apiInt(approval.gasPrice, 'approve gasPrice'),
  });
  const outcome = sentOrFailure(result, 'approve', simulatedAt, {
    token,
    spender,
    amount: args.amount.toString(),
  });
  if ('receipt' in outcome)
    return { kind: 'ready', spender, via: 'sent', simulation, sent: outcome };
  return outcome;
}

/**
 * Builds, checks, simulates and (live) sends the swap for a fresh quote. The received amount is
 * read from the receipt logs, never from the quote (SPEC §5.8).
 */
export async function performSwap(
  deps: TradeDeps,
  args: {
    planId: string;
    cycleId: number;
    instrument: Instrument;
    amount: bigint;
    quote: QuoteObservation;
    route: QuoteRoute;
    spender: Hex;
    /** This cycle's own approval was mined moments ago (simulateAfterApproval). */
    justApproved?: boolean;
  },
): Promise<SwapResult> {
  const { quote, route, instrument } = args;
  if (!quote.quoteId) return fail('QUOTE_INCOMPLETE', 'quote has no quoteId');
  if (route.approveTarget && !isAddressEqual(route.approveTarget as Hex, args.spender)) {
    return fail(
      'SPENDER_MISMATCH',
      `quote approveTarget ${route.approveTarget} ≠ approved spender ${args.spender}`,
    );
  }
  let build;
  try {
    build = await buildSwap(deps.client, {
      quoteId: quote.quoteId,
      fromToken: BSC_USDT,
      toToken: instrument.address,
      amount: args.amount,
      userWalletAddress: deps.house,
      slippagePercent: SLIPPAGE_PERCENT,
    });
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    if (error.classify().action === 'requote')
      return { kind: 'requote', reason: `${error.code}: ${error.msg}` };
    return apiFailure('swap', error);
  }
  const { tx } = build;
  if (build.executionMode && build.executionMode !== 'SWAP') {
    // RFQ orders are EIP-712 messages outside our signing path until a human approves it (Q-15).
    return { kind: 'requote', reason: `swap came back as ${build.executionMode}` };
  }
  if (!isAddressEqual(tx.from as Hex, deps.house)) {
    return fail('SWAP_SENDER_MISMATCH', `swap tx.from ${tx.from} is not the house wallet`);
  }
  const value = apiInt(tx.value ?? '0', 'swap value');
  if (value !== 0n)
    return fail('SWAP_CARRIES_BNB', `swap tx.value ${value} (USDT swaps carry no BNB)`);
  // The swap must call the router we approved, nothing else (every recorded /swap does).
  if (!isAddressEqual(tx.to as Hex, args.spender)) {
    return fail(
      'SWAP_TARGET_MISMATCH',
      `swap calls ${tx.to}, not the approved router ${args.spender}`,
    );
  }

  const call = { from: deps.house, to: tx.to, value: '0', data: tx.data };
  let simulation: SimulationResult;
  try {
    simulation = await simulateAfterApproval(deps, args.justApproved === true, () =>
      simulateCall(deps.client, call),
    );
  } catch (error) {
    if (error instanceof BinanceApiError) return apiFailure('simulate swap', error);
    throw error;
  }
  const simulatedAt = deps.now().toISOString();
  if (deps.mode === 'simulate') {
    return {
      kind: 'simulated',
      simulation,
      router: tx.to,
      minReceive: tx.minReceiveAmount ?? null,
    };
  }
  if (simulation.status !== 'SUCCESS') {
    return fail('SIM_SWAP', `swap simulation ${simulation.status}: ${simulation.failReason}`);
  }
  // The quote must still be fresh when it is signed (30 s TTL, Q-04).
  if (deps.now().getTime() - Date.parse(quote.receivedAt) > MAX_QUOTE_AGE_MS) {
    return { kind: 'requote', reason: 'quote older than 25 s at signing' };
  }

  const result = await sendTransaction(sendDeps(deps), {
    planId: args.planId,
    cycleId: args.cycleId,
    kind: 'swap',
    to: tx.to,
    data: tx.data,
    value: 0n,
    gas: apiInt(tx.gas, 'swap gas'),
    gasPrice: apiInt(tx.gasPrice, 'swap gasPrice'),
    ...(tx.maxPriorityFeePerGas
      ? { maxPriorityFeePerGas: apiInt(tx.maxPriorityFeePerGas, 'swap maxPriorityFeePerGas') }
      : {}),
  });
  if (result.state !== 'confirmed') {
    const outcome = sentOrFailure(result, 'swap', simulatedAt, {});
    if ('receipt' in outcome) throw new Error('unreachable');
    return outcome;
  }
  const receivedTokens = transferredTo(result.receipt.logs, instrument.address, deps.house);
  const spentUnits = transferredFrom(result.receipt.logs, BSC_USDT, deps.house);
  const sent: SentTx = {
    kind: 'swap',
    txHash: result.txHash,
    broadcastVia: result.broadcastVia,
    receipt: result.receipt,
    simulatedAt,
    amounts: {
      instrumentId: instrument.id,
      spentUsdtUnits: spentUnits.toString(),
      receivedTokens: receivedTokens.toString(),
      minReceive: tx.minReceiveAmount ?? '',
    },
  };
  if (receivedTokens === 0n) {
    const message = `swap ${result.txHash} confirmed, ${spentUnits} USDT units left the wallet, no ${instrument.symbol} arrived`;
    return { kind: 'anomaly', message, sent };
  }
  return { kind: 'bought', receivedTokens, spentUnits, sent };
}
