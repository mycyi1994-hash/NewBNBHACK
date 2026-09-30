/**
 * Live state of one deployed RWA pool, read at a single block: the fee each swap direction pays
 * right now and why, the halt flag, the pool price against the reference, and what the vault
 * holds. Read-only; a pool that cannot be read is UNAVAILABLE with the reason, never a guess.
 */
import {
  encodePacked,
  keccak256,
  pad,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { UsSession } from '@yieldvest/core';
import { keeperReferenceOracleAbi, rwaLiquidityVaultAbi, rwaSessionHookAbi } from './abi.js';
import { SESSION_CODES } from './calendar-vectors.js';
import type { RwaLpDeployment } from './manifest.js';
import { rwaPriceE18 } from './price.js';

/** `RwaSessionHook.FeeReason`, in enum order. */
export const FEE_REASONS = [
  'regular',
  'opening_ramp',
  'extended',
  'closed',
  'corporate_action',
  'reference_gap',
] as const;
export type FeeReason = (typeof FEE_REASONS)[number];

export type LpReader = Pick<PublicClient, 'readContract' | 'getBlock' | 'getBlockNumber'>;

export interface SwapFee {
  /** Hundredths of a bip (1_000_000 = 100%). */
  feePips: number;
  reason: FeeReason;
}

export interface LpStatusLive {
  state: 'LIVE';
  deployment: RwaLpDeployment;
  blockNumber: bigint;
  at: Date;
  session: UsSession;
  halted: boolean;
  liquidityGate: Address;
  maxReferenceAge: number;
  /** Paying the quote token for the stock. */
  buy: SwapFee;
  /** Paying the stock for the quote token. */
  sell: SwapFee;
  poolPriceE18: bigint;
  reference: { priceE18: bigint; observedAt: Date; ageSeconds: number; fresh: boolean } | null;
  vault: {
    totalSupply: bigint;
    liquidity: bigint;
    rwaAmount: bigint;
    quoteAmount: bigint;
    allowlistEnabled: boolean;
  };
}

export type LpStatus =
  LpStatusLive | { state: 'UNAVAILABLE'; deployment: RwaLpDeployment; reason: string };

const extsloadAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);

/** Uniswap v4 StateLibrary: `pools` is mapping slot 6 of the PoolManager, keyed by pool id. */
export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(encodePacked(['bytes32', 'bytes32'], [poolId, pad('0x06', { size: 32 })]));
}

/** Slot0: sqrtPriceX96 (160 bits) | tick (24, signed) | protocolFee (24) | lpFee (24). */
export function decodeSlot0(word: Hex): { sqrtPriceX96: bigint; tick: number; lpFee: number } {
  const value = BigInt(word);
  const rawTick = Number((value >> 160n) & 0xffffffn);
  return {
    sqrtPriceX96: value & ((1n << 160n) - 1n),
    tick: rawTick >= 0x800000 ? rawTick - 0x1000000 : rawTick,
    lpFee: Number((value >> 208n) & 0xffffffn),
  };
}

function sessionName(code: number): UsSession {
  const name = SESSION_CODES[code];
  if (name === undefined) throw new Error(`unknown session code ${code}`);
  return name;
}

function reasonName(code: number): FeeReason {
  const name = FEE_REASONS[code];
  if (name === undefined) throw new Error(`unknown fee reason ${code}`);
  return name;
}

/** One line of why a read failed: viem's short message, never its full text (it can hold URLs). */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const short = (error as { shortMessage?: unknown }).shortMessage;
  return typeof short === 'string' ? short : (error.message.split('\n')[0] ?? 'unknown error');
}

export async function readLpStatus(client: LpReader, d: RwaLpDeployment): Promise<LpStatus> {
  try {
    const blockNumber = await client.getBlockNumber();
    const at = { blockNumber } as const;
    const key = {
      currency0: d.currency0,
      currency1: d.currency1,
      fee: d.fee,
      tickSpacing: d.tickSpacing,
      hooks: d.hook,
    } as const;
    const rwaIsCurrency0 = d.rwaToken === d.currency0;
    const hook = { address: d.hook, abi: rwaSessionHookAbi, ...at } as const;
    const vault = { address: d.vault, abi: rwaLiquidityVaultAbi, ...at } as const;
    const [
      block,
      config,
      buy,
      sell,
      slot0,
      reference,
      totalSupply,
      liquidity,
      totals,
      allowlistEnabled,
      rwaDecimals,
      quoteDecimals,
    ] = await Promise.all([
      client.getBlock({ blockNumber }),
      client.readContract({ ...hook, functionName: 'poolConfig', args: [d.poolId] }),
      client.readContract({ ...hook, functionName: 'quoteFee', args: [key, !rwaIsCurrency0] }),
      client.readContract({ ...hook, functionName: 'quoteFee', args: [key, rwaIsCurrency0] }),
      client.readContract({
        address: d.poolManager,
        abi: extsloadAbi,
        functionName: 'extsload',
        args: [poolStateSlot(d.poolId)],
        ...at,
      }),
      client.readContract({
        address: d.oracle,
        abi: keeperReferenceOracleAbi,
        functionName: 'referencePrice',
        args: [d.rwaToken],
        ...at,
      }),
      client.readContract({ ...vault, functionName: 'totalSupply' }),
      client.readContract({ ...vault, functionName: 'positionLiquidity' }),
      client.readContract({ ...vault, functionName: 'totalAmounts' }),
      client.readContract({ ...vault, functionName: 'allowlistEnabled' }),
      client.readContract({
        address: d.rwaToken,
        abi: decimalsAbi,
        functionName: 'decimals',
        ...at,
      }),
      client.readContract({
        address: d.quoteToken,
        abi: decimalsAbi,
        functionName: 'decimals',
        ...at,
      }),
    ]);

    const { sqrtPriceX96 } = decodeSlot0(slot0);
    if (sqrtPriceX96 === 0n) throw new Error('the pool is not initialized');
    const now = Number(block.timestamp);
    const [referencePriceE18, observedAt] = reference;
    const maxReferenceAge = config.fees.maxReferenceAge;
    const [amount0, amount1] = totals;
    return {
      state: 'LIVE',
      deployment: d,
      blockNumber,
      at: new Date(now * 1000),
      session: sessionName(buy[1]),
      halted: config.halted,
      liquidityGate: config.liquidityGate,
      maxReferenceAge,
      buy: { feePips: buy[0], reason: reasonName(buy[2]) },
      sell: { feePips: sell[0], reason: reasonName(sell[2]) },
      poolPriceE18: rwaPriceE18(sqrtPriceX96, rwaIsCurrency0, rwaDecimals, quoteDecimals),
      reference:
        referencePriceE18 === 0n
          ? null
          : {
              priceE18: referencePriceE18,
              observedAt: new Date(Number(observedAt) * 1000),
              ageSeconds: now - Number(observedAt),
              fresh: now - Number(observedAt) <= maxReferenceAge && Number(observedAt) <= now,
            },
      vault: {
        totalSupply,
        liquidity,
        rwaAmount: rwaIsCurrency0 ? amount0 : amount1,
        quoteAmount: rwaIsCurrency0 ? amount1 : amount0,
        allowlistEnabled,
      },
    };
  } catch (error) {
    return { state: 'UNAVAILABLE', deployment: d, reason: reasonOf(error) };
  }
}
