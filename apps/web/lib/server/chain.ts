/**
 * Chain reads the web does itself (public BSC RPC, no keys): a skill wallet's Venus position and
 * the transactions it reports. Tests replace them with setChainForTests.
 */
import { createBscClient, readVTokenBalance, vTokenAbi } from '@ijaro/chain';
import type { Config } from '@ijaro/config';
import { fromUnits, underlyingFromVTokens } from '@ijaro/core';
import { getAddress } from 'viem';
import { viemReader, type ChainReader } from './report';

export interface WebChain extends ChainReader {
  /** The latest block (smoke check: the RPC answers). */
  blockNumber(): Promise<bigint>;
  /** The wallet's Venus position in USD (18-decimal string). */
  venusPositionUsd(vToken: string, wallet: string): Promise<string>;
  /** What `vTokens` of the market are worth now, USD. */
  vTokensUsd(vToken: string, vTokens: bigint): Promise<string>;
}

let override: WebChain | undefined;

export function setChainForTests(chain: WebChain | undefined): void {
  override = chain;
}

export function webChain(config: Config): WebChain {
  if (override) return override;
  const bsc = createBscClient(config.bsc);
  return {
    ...viemReader(bsc),
    blockNumber: () => bsc.getBlockNumber(),
    async venusPositionUsd(vToken, wallet) {
      const [balance, rate] = await Promise.all([
        readVTokenBalance(bsc, vToken, wallet),
        bsc.readContract({
          address: getAddress(vToken),
          abi: vTokenAbi,
          functionName: 'exchangeRateStored',
        }),
      ]);
      return fromUnits(underlyingFromVTokens(balance, rate), 18);
    },
    async vTokensUsd(vToken, vTokens) {
      const rate = await bsc.readContract({
        address: getAddress(vToken),
        abi: vTokenAbi,
        functionName: 'exchangeRateStored',
      });
      return fromUnits(underlyingFromVTokens(vTokens, rate), 18);
    },
  };
}
