/**
 * The chain operations the executor needs, behind a narrow port so tests can run the whole buy
 * path against an in-memory chain. `viemChainPort` is the real one (BSC RPC with fallback).
 */
import {
  readAllowance,
  readTokenBalance,
  readVTokenState,
  vTokenAbi,
  type BscClient,
} from '@ijaro/chain';
import { utilizationBps } from '@ijaro/core';
import { getAddress, WaitForTransactionReceiptTimeoutError, type Hex, type Log } from 'viem';

export interface ReceiptLike {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: readonly Log[];
}

export interface ChainPort {
  allowance(token: string, owner: string, spender: string): Promise<bigint>;
  balanceOf(token: string, holder: string): Promise<bigint>;
  /** Venus vToken exchangeRateStored (underlying per vToken, 1e18-scaled). */
  exchangeRate(vToken: string): Promise<bigint>;
  /** Venus vToken underlying() — the market's asset. */
  underlyingOf(vToken: string): Promise<string>;
  /** Venus market guard flags and utilisation (guardian inputs, PLAN §7). */
  venusMarketState(
    vToken: string,
  ): Promise<{ mintPaused: boolean; redeemPaused: boolean; utilizationBps: number }>;
  /** Next nonce including the sender's pending transactions. */
  pendingNonce(address: string): Promise<number>;
  /** Next nonce counting mined transactions only. */
  minedNonce(address: string): Promise<number>;
  /** eth_sendRawTransaction; returns the hash the node computed. */
  sendRaw(raw: Hex): Promise<Hex>;
  /** Waits for the receipt; undefined when it did not arrive within `timeoutMs`. */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<ReceiptLike | undefined>;
  /** The receipt if the transaction is mined, else undefined (boot reconciliation). */
  receipt(hash: Hex): Promise<ReceiptLike | undefined>;
}

export function viemChainPort(bsc: BscClient): ChainPort {
  const toLike = (r: {
    status: 'success' | 'reverted';
    blockNumber: bigint;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    logs: Log[];
  }): ReceiptLike => ({
    status: r.status,
    blockNumber: r.blockNumber,
    gasUsed: r.gasUsed,
    effectiveGasPrice: r.effectiveGasPrice,
    logs: r.logs,
  });
  return {
    allowance: (token, owner, spender) => readAllowance(bsc, token, owner, spender),
    balanceOf: (token, holder) => readTokenBalance(bsc, token, holder),
    exchangeRate: (vToken) =>
      bsc.readContract({
        address: getAddress(vToken),
        abi: vTokenAbi,
        functionName: 'exchangeRateStored',
      }),
    underlyingOf: (vToken) =>
      bsc.readContract({ address: getAddress(vToken), abi: vTokenAbi, functionName: 'underlying' }),
    async venusMarketState(vToken) {
      const state = await readVTokenState(bsc, vToken);
      return {
        mintPaused: state.mintPaused,
        redeemPaused: state.redeemPaused,
        utilizationBps: utilizationBps(state.cash, state.totalBorrows, state.totalReserves),
      };
    },
    pendingNonce: (address) =>
      bsc.getTransactionCount({ address: getAddress(address), blockTag: 'pending' }),
    minedNonce: (address) =>
      bsc.getTransactionCount({ address: getAddress(address), blockTag: 'latest' }),
    sendRaw: (raw) => bsc.sendRawTransaction({ serializedTransaction: raw }),
    async waitForReceipt(hash, timeoutMs) {
      try {
        return toLike(
          await bsc.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_000 }),
        );
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) return undefined;
        throw error;
      }
    },
    async receipt(hash) {
      try {
        return toLike(await bsc.getTransactionReceipt({ hash }));
      } catch (error) {
        if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') {
          return undefined;
        }
        throw error;
      }
    },
  };
}
