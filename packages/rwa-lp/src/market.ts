/**
 * The tokenized-stock pools already on Uniswap v4 on BSC — the market the RwaSessionHook is for
 * (docs/RWA_LP.md §1). Public BSC RPCs cannot list a contract's events over any useful range
 * (dx/LOG.md 2026-09-30 02:10), so the pools are found the way a router finds them: the id of
 * every candidate key — the token against each stablecoin, at each standard fee tier, with no
 * hook — is read from StateView in one multicall, and the initialized ones are priced with the
 * hook's own arithmetic. A hooked pool cannot be found this way (its key holds the hook address).
 * Read-only.
 */
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { UNISWAP_V4_BSC } from './addresses.js';
import { rwaPriceE18 } from './price.js';

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  /** Hundredths of a bip; 0x800000 marks a dynamic-fee pool. */
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Uniswap v4 `PoolIdLibrary.toId`: keccak256 of the ABI-encoded key. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** The stablecoins tokenized stocks are quoted in on BSC (SPEC §3.4), 18 decimals each. */
export const BSC_STABLES = [
  { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
] as const;

/** Uniswap's standard fee tiers and the tick spacing each is created with. */
export const STANDARD_TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3_000, tickSpacing: 60 },
  { fee: 10_000, tickSpacing: 200 },
] as const;

const NO_HOOK = '0x0000000000000000000000000000000000000000';
/** Within this many ticks of the ±887,272 bounds a pool has been drained to one side. */
const LIMIT_TICK = 887_000;

export interface CandidatePool {
  key: PoolKey;
  id: Hex;
  quote: (typeof BSC_STABLES)[number];
  rwaIsCurrency0: boolean;
}

/** Every hookless stablecoin pool key a token could have, at the standard tiers. */
export function candidatePools(token: Address): CandidatePool[] {
  const rwa = getAddress(token);
  return BSC_STABLES.flatMap((quote) =>
    STANDARD_TIERS.map(({ fee, tickSpacing }) => {
      const rwaIsCurrency0 = BigInt(rwa) < BigInt(quote.address);
      const key: PoolKey = {
        currency0: rwaIsCurrency0 ? rwa : quote.address,
        currency1: rwaIsCurrency0 ? quote.address : rwa,
        fee,
        tickSpacing,
        hooks: NO_HOOK,
      };
      return { key, id: poolIdOf(key), quote, rwaIsCurrency0 };
    }),
  );
}

const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

export interface MarketPool {
  quote: string;
  /** Hundredths of a bip. */
  fee: number;
  poolId: Hex;
  /** Quote-token units (≈ USD) per whole token, 18 decimals. */
  priceE18: bigint;
  /** In-range liquidity: 0 means no trade can happen at this price. */
  liquidity: bigint;
  tick: number;
  /** Drained to one side: the price is the tick bound, not a market. */
  atPriceLimit: boolean;
}

export type MarketReader = Pick<PublicClient, 'multicall' | 'getBlockNumber'>;

/** The initialized candidate pools of `token`, read at one block. */
export async function readMarketPools(
  client: MarketReader,
  token: { address: Address; decimals: number },
): Promise<{ blockNumber: bigint; pools: MarketPool[] }> {
  const blockNumber = await client.getBlockNumber();
  const candidates = candidatePools(token.address);
  const results = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: candidates.flatMap(({ id }) => [
      {
        address: UNISWAP_V4_BSC.stateView,
        abi: stateViewAbi,
        functionName: 'getSlot0',
        args: [id],
      } as const,
      {
        address: UNISWAP_V4_BSC.stateView,
        abi: stateViewAbi,
        functionName: 'getLiquidity',
        args: [id],
      } as const,
    ]),
  });
  const pools: MarketPool[] = [];
  candidates.forEach((candidate, i) => {
    const [sqrtPriceX96, tick] = results[2 * i] as readonly [bigint, number, number, number];
    const liquidity = results[2 * i + 1] as bigint;
    if (sqrtPriceX96 === 0n) return; // no pool with this key
    pools.push({
      quote: candidate.quote.symbol,
      fee: candidate.key.fee,
      poolId: candidate.id,
      priceE18: rwaPriceE18(
        sqrtPriceX96,
        candidate.rwaIsCurrency0,
        token.decimals,
        candidate.quote.decimals,
      ),
      liquidity,
      tick,
      atPriceLimit: Math.abs(tick) >= LIMIT_TICK,
    });
  });
  return { blockNumber, pools };
}
