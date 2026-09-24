/**
 * BSC reads and writes with viem (SPEC §3.4): ERC-20 symbol/decimals checks (M0-05), Venus vUSDT
 * and Comptroller reads (M0-07), BEP-677 share multiplier (M1-08). Addresses of stock tokens never
 * live here — they come from the RWA registry (DECISIONS D-07).
 */
import { createPublicClient, fallback, getAddress, http, parseAbi, type Address } from 'viem';
import { bsc } from 'viem/chains';

export const BSC_CHAIN_ID = 56;

export function createBscClient(rpc: { rpcUrl: string; rpcUrlFallback: string }) {
  return createPublicClient({
    chain: bsc,
    transport: fallback([http(rpc.rpcUrl), http(rpc.rpcUrlFallback)]),
  });
}

export type BscClient = ReturnType<typeof createBscClient>;

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
]);

/**
 * bStocks share multiplier. Function names come from the implementation bytecode behind the token's
 * beacon proxy (selectors of uiMultiplier(), newUIMultiplier(), effectiveAt()) — DECISIONS Q-13.
 * All three are 1e18-scaled / unix seconds.
 */
export const bstockMultiplierAbi = parseAbi([
  'function uiMultiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint256)',
]);

/** Venus (Compound v2 fork) vToken reads used by M0-07 and the yield budget (SPEC §5.3). */
export const vTokenAbi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function underlying() view returns (address)',
  'function comptroller() view returns (address)',
  'function exchangeRateStored() view returns (uint256)',
  'function getCash() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalReserves() view returns (uint256)',
  'function supplyRatePerBlock() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

/** Comptroller guard flags for one market (SPEC §5.7 guardian input). */
export const comptrollerAbi = parseAbi([
  'function actionPaused(address market, uint8 action) view returns (bool)',
]);

/** Venus Comptroller `Action` enum values we care about: MINT = 0, REDEEM = 1. */
export const VENUS_ACTION = { MINT: 0, REDEEM: 1 } as const;

export interface Erc20Meta {
  address: Address;
  symbol: string;
  decimals: number;
}

export async function readErc20Meta(client: BscClient, address: string): Promise<Erc20Meta> {
  const token = getAddress(address);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return { address: token, symbol, decimals };
}

export interface BstockMultiplier {
  uiMultiplier: bigint;
  newUIMultiplier: bigint;
  /** Unix seconds when newUIMultiplier takes over; 0 = no change scheduled. */
  effectiveAt: bigint;
}

export async function readBstockMultiplier(
  client: BscClient,
  address: string,
): Promise<BstockMultiplier> {
  const token = getAddress(address);
  const [uiMultiplier, newUIMultiplier, effectiveAt] = await Promise.all([
    client.readContract({ address: token, abi: bstockMultiplierAbi, functionName: 'uiMultiplier' }),
    client.readContract({
      address: token,
      abi: bstockMultiplierAbi,
      functionName: 'newUIMultiplier',
    }),
    client.readContract({ address: token, abi: bstockMultiplierAbi, functionName: 'effectiveAt' }),
  ]);
  return { uiMultiplier, newUIMultiplier, effectiveAt };
}

export interface VTokenState {
  address: Address;
  symbol: string;
  decimals: number;
  underlying: Address;
  comptroller: Address;
  /** Underlying per vToken, scaled by 1e(18 + underlyingDecimals − vTokenDecimals). */
  exchangeRateStored: bigint;
  cash: bigint;
  totalBorrows: bigint;
  totalReserves: bigint;
  supplyRatePerBlock: bigint;
  mintPaused: boolean;
  redeemPaused: boolean;
  blockNumber: bigint;
}

export async function readVTokenState(client: BscClient, vToken: string): Promise<VTokenState> {
  const address = getAddress(vToken);
  const blockNumber = await client.getBlockNumber();
  const read = <F extends 'symbol' | 'decimals' | 'underlying' | 'comptroller'>(functionName: F) =>
    client.readContract({ address, abi: vTokenAbi, functionName, blockNumber });
  const readUint = (
    functionName:
      'exchangeRateStored' | 'getCash' | 'totalBorrows' | 'totalReserves' | 'supplyRatePerBlock',
  ) => client.readContract({ address, abi: vTokenAbi, functionName, blockNumber });
  const [symbol, decimals, underlying, comptroller] = await Promise.all([
    read('symbol'),
    read('decimals'),
    read('underlying'),
    read('comptroller'),
  ]);
  const [exchangeRateStored, cash, totalBorrows, totalReserves, supplyRatePerBlock] =
    await Promise.all([
      readUint('exchangeRateStored'),
      readUint('getCash'),
      readUint('totalBorrows'),
      readUint('totalReserves'),
      readUint('supplyRatePerBlock'),
    ]);
  const paused = (action: number) =>
    client.readContract({
      address: comptroller,
      abi: comptrollerAbi,
      functionName: 'actionPaused',
      args: [address, action],
      blockNumber,
    });
  const [mintPaused, redeemPaused] = await Promise.all([
    paused(VENUS_ACTION.MINT),
    paused(VENUS_ACTION.REDEEM),
  ]);
  return {
    address,
    symbol,
    decimals,
    underlying,
    comptroller,
    exchangeRateStored,
    cash,
    totalBorrows,
    totalReserves,
    supplyRatePerBlock,
    mintPaused,
    redeemPaused,
    blockNumber,
  };
}

export async function readVTokenBalance(
  client: BscClient,
  vToken: string,
  holder: string,
): Promise<bigint> {
  return client.readContract({
    address: getAddress(vToken),
    abi: vTokenAbi,
    functionName: 'balanceOf',
    args: [getAddress(holder)],
  });
}

/**
 * BSC USDT (BEP-20, 18 decimals) — the quote currency, not a stock token. Checked at start-up with
 * `assertUsdt` (symbol "USDT", 18 decimals) so a wrong constant fails loudly.
 */
export const BSC_USDT: Address = '0x55d398326f99059fF775485246999027B3197955';

export async function assertUsdt(client: BscClient): Promise<Erc20Meta> {
  const meta = await readErc20Meta(client, BSC_USDT);
  if (meta.symbol !== 'USDT' || meta.decimals !== 18) {
    throw new Error(`BSC_USDT check failed: ${meta.symbol}/${meta.decimals}`);
  }
  return meta;
}
