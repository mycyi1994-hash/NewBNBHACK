/**
 * Chain reads the web does itself (public BSC RPC, no keys): Venus positions, the transactions a
 * skill wallet reports, and a wallet's holdings for the /wallet view. Tests replace them with
 * setChainForTests.
 */
import {
  BSC_USDT,
  createBscClient,
  readVTokenBalance,
  vTokenAbi,
  type BstockMultiplier,
} from '@yieldvest/chain';
import type { Config } from '@yieldvest/config';
import { fromUnits, toUnits, underlyingFromVTokens } from '@yieldvest/core';
import { usdText, type PlanRow } from '@yieldvest/db';
import { getAddress, parseAbi, type Address } from 'viem';
import { viemReader, type ChainReader } from './report';

/** One block's reading of a wallet (the /wallet view, DECISIONS D-32). */
export interface WalletReading {
  blockNumber: bigint;
  /** Unix seconds of that block. */
  blockTime: bigint;
  /** Base units by lowercase token address; a balance that could not be read is absent. */
  balances: Map<string, bigint>;
  /** bStocks multipliers by lowercase token address, when all three of its reads answered. */
  multipliers: Map<string, BstockMultiplier>;
  /** The wallet's USDT in base units (18 decimals); null when the read failed. */
  usdt: bigint | null;
  /** The wallet's vTokens and the market's exchange rate; null when not asked or not read. */
  venus: { vTokens: bigint; exchangeRate: bigint } | null;
}

/** Every read the wallet view makes returns one uint256: one ABI, one multicall, one block. */
const walletReadAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function uiMultiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint256)',
  'function exchangeRateStored() view returns (uint256)',
]);

type WalletCall =
  | {
      address: Address;
      abi: typeof walletReadAbi;
      functionName: 'balanceOf';
      args: readonly [Address];
    }
  | {
      address: Address;
      abi: typeof walletReadAbi;
      functionName: 'uiMultiplier' | 'newUIMultiplier' | 'effectiveAt' | 'exchangeRateStored';
    };

export interface WebChain extends ChainReader {
  /** The latest block (smoke check: the RPC answers). */
  blockNumber(): Promise<bigint>;
  /** The wallet's vToken balance (base units). */
  vTokenBalance(vToken: string, wallet: string): Promise<bigint>;
  /** What `vTokens` of the market are worth now, USD. */
  vTokensUsd(vToken: string, vTokens: bigint): Promise<string>;
  /**
   * A wallet at the latest block: each token's balance (and each bStocks token's multiplier),
   * its USDT and, given the Venus market, its vTokens with the market's rate.
   */
  readWallet(
    wallet: string,
    tokens: readonly { address: string; bstocks: boolean }[],
    vToken: string | null,
  ): Promise<WalletReading>;
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
    async readWallet(wallet, tokens, vToken) {
      const block = await bsc.getBlock();
      const holder = getAddress(wallet);
      const balanceOf = (address: string): WalletCall => ({
        address: getAddress(address),
        abi: walletReadAbi,
        functionName: 'balanceOf',
        args: [holder],
      });
      const view = (
        address: string,
        functionName: Exclude<WalletCall['functionName'], 'balanceOf'>,
      ): WalletCall => ({ address: getAddress(address), abi: walletReadAbi, functionName });
      const bstocks = tokens.filter((t) => t.bstocks);
      const calls: WalletCall[] = [
        ...tokens.map((t) => balanceOf(t.address)),
        ...bstocks.flatMap((t) => [
          view(t.address, 'uiMultiplier'),
          view(t.address, 'newUIMultiplier'),
          view(t.address, 'effectiveAt'),
        ]),
        balanceOf(BSC_USDT),
        ...(vToken ? [balanceOf(vToken), view(vToken, 'exchangeRateStored')] : []),
      ];
      const results = await bsc.multicall({
        contracts: calls,
        blockNumber: block.number,
        allowFailure: true,
      });
      let next = 0;
      const take = (): bigint | null => {
        const r = results[next++];
        return r?.status === 'success' && typeof r.result === 'bigint' ? r.result : null;
      };
      const balances = new Map<string, bigint>();
      for (const t of tokens) {
        const value = take();
        if (value !== null) balances.set(t.address.toLowerCase(), value);
      }
      const multipliers = new Map<string, BstockMultiplier>();
      for (const t of bstocks) {
        const [uiMultiplier, newUIMultiplier, effectiveAt] = [take(), take(), take()];
        if (uiMultiplier !== null && newUIMultiplier !== null && effectiveAt !== null) {
          multipliers.set(t.address.toLowerCase(), { uiMultiplier, newUIMultiplier, effectiveAt });
        }
      }
      const usdt = take();
      const [vTokens, exchangeRate] = vToken ? [take(), take()] : [null, null];
      return {
        blockNumber: block.number,
        blockTime: block.timestamp,
        balances,
        multipliers,
        usdt,
        venus: vTokens !== null && exchangeRate !== null ? { vTokens, exchangeRate } : null,
      };
    },
  };
}
