/**
 * Chain reads the web does itself (public BSC RPC, no keys): Venus positions and the transactions
 * a skill wallet reports. Tests replace them with setChainForTests.
 */
import { createBscClient, readVTokenBalance, vTokenAbi } from '@ijaro/chain';
import type { Config } from '@ijaro/config';
import { fromUnits, toUnits, underlyingFromVTokens } from '@ijaro/core';
import { usdText, type PlanRow } from '@ijaro/db';
import { getAddress } from 'viem';
import { viemReader, type ChainReader } from './report';

export interface WebChain extends ChainReader {
  /** The latest block (smoke check: the RPC answers). */
  blockNumber(): Promise<bigint>;
  /** The wallet's vToken balance (base units). */
  vTokenBalance(vToken: string, wallet: string): Promise<bigint>;
  /** What `vTokens` of the market are worth now, USD. */
  vTokensUsd(vToken: string, vTokens: bigint): Promise<string>;
}

/**
 * What a yield plan's Venus position is worth now: the vTokens its own receipts put on record —
 * for a skill plan never more than its wallet still holds, and never the wallet's other deposits.
 * Undefined while the plan has no principal on record (nothing of it is in Venus yet).
 */
export async function planPositionUsd(
  chain: WebChain,
  vToken: string,
  row: Pick<PlanRow, 'ownerKind' | 'walletAddress' | 'principalUsd' | 'vtokenUnits'>,
): Promise<string | undefined> {
  if (toUnits(usdText(row.principalUsd), 18) <= 0n) return undefined;
  let vTokens = BigInt(row.vtokenUnits);
  if (row.ownerKind === 'skill') {
    if (!row.walletAddress) return undefined;
    const held = await chain.vTokenBalance(vToken, row.walletAddress);
    if (held < vTokens) vTokens = held;
  }
  return chain.vTokensUsd(vToken, vTokens);
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
    vTokenBalance: (vToken, wallet) => readVTokenBalance(bsc, vToken, wallet),
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
