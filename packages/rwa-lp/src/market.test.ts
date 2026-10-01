import { describe, expect, it } from 'vitest';
import {
  BSC_STABLES,
  candidatePools,
  poolIdOf,
  readMarketPools,
  type MarketReader,
} from './market.js';
import { rwaPriceE18 } from './price.js';

// Token addresses from the public RWA list (chain 56), test data only — product code takes them
// from the registry.
const NVDAB = '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436';
const NVDAON = '0xA9eE28C80f960B889dFbd1902055218cBa016F75';
const USDT = BSC_STABLES[0].address;
const NO_HOOK = '0x0000000000000000000000000000000000000000';

describe('poolIdOf', () => {
  it('gives the ids under which BSC holds initialized pools (StateView, block 125049896)', () => {
    // A wrong encoding would hash to an empty slot: these two ids answered with a price.
    expect(
      poolIdOf({ currency0: NVDAB, currency1: USDT, fee: 100, tickSpacing: 1, hooks: NO_HOOK }),
    ).toBe('0x7200051459ffa682eee37e4aeec4c0b5a27a728b33238add2739ab4a3abc6a44');
    expect(
      poolIdOf({ currency0: USDT, currency1: NVDAON, fee: 100, tickSpacing: 1, hooks: NO_HOOK }),
    ).toBe('0xf8bad4715260c16367227581afc29bf3a625b877b9440816c5712a3aeebd0056');
  });
});

describe('candidatePools', () => {
  it('pairs the token with each stablecoin at the four standard tiers, currencies sorted', () => {
    const pools = candidatePools(NVDAB.toLowerCase() as `0x${string}`);
    expect(pools).toHaveLength(8);
    for (const { key, rwaIsCurrency0, id } of pools) {
      expect(BigInt(key.currency0) < BigInt(key.currency1)).toBe(true);
      expect(rwaIsCurrency0 ? key.currency0 : key.currency1).toBe(NVDAB);
      expect(key.hooks).toBe(NO_HOOK);
      expect(id).toBe(poolIdOf(key));
    }
    expect(pools.map((p) => `${p.quote.symbol}/${p.key.fee}/${p.key.tickSpacing}`)).toEqual([
      'USDT/100/1',
      'USDT/500/10',
      'USDT/3000/60',
      'USDT/10000/200',
      'USDC/100/1',
      'USDC/500/10',
      'USDC/3000/60',
      'USDC/10000/200',
    ]);
  });
});

describe('readMarketPools', () => {
  it('returns only initialized pools, priced like the hook, and marks a drained one', async () => {
    const sqrtPrice = 1_187_620_854_163_437_043_036_413_513_496n; // ≈ 224.7 USDT per NVDAB
    const answers = new Map<number, readonly [bigint, number, number, number] | bigint>();
    // Candidate 0 (USDT 0.01%): a market; candidate 3 (USDT 1%): drained; the rest: no pool.
    answers.set(0, [sqrtPrice, 54_157, 0, 100]);
    answers.set(1, 5n);
    answers.set(6, [4_295_128_740n, 887_271, 0, 10_000]);
    answers.set(7, 0n);
    const client: MarketReader = {
      getBlockNumber: () => Promise.resolve(125_049_896n),
      multicall: ((args: { contracts: unknown[] }) =>
        Promise.resolve(
          args.contracts.map((_c, i) => answers.get(i) ?? (i % 2 === 0 ? [0n, 0, 0, 0] : 0n)),
        )) as unknown as MarketReader['multicall'],
    };
    const { blockNumber, pools } = await readMarketPools(client, { address: NVDAB, decimals: 18 });
    expect(blockNumber).toBe(125_049_896n);
    expect(pools).toEqual([
      {
        quote: 'USDT',
        fee: 100,
        poolId: poolIdOf({
          currency0: NVDAB,
          currency1: USDT,
          fee: 100,
          tickSpacing: 1,
          hooks: NO_HOOK,
        }),
        priceE18: rwaPriceE18(sqrtPrice, true, 18, 18),
        liquidity: 5n,
        tick: 54_157,
        atPriceLimit: false,
      },
      expect.objectContaining({ quote: 'USDT', fee: 10_000, liquidity: 0n, atPriceLimit: true }),
    ]);
    expect(pools[0]?.priceE18).toBeGreaterThan(224n * 10n ** 18n);
    expect(pools[0]?.priceE18).toBeLessThan(225n * 10n ** 18n);
  });
});
