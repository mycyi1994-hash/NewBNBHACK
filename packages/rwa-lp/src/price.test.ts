import { describe, expect, it } from 'vitest';
import { feePercent, formatE18, gapPips, rwaPriceE18 } from './price.js';

const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

// Shared with contracts/test/PoolPriceMath.t.sol: both sides must give these exact values.
const VECTORS: [bigint, boolean, number, number, bigint][] = [
  // NVDAB/USDT hookless v4 pool on BSC, block 124826328 (dx/LOG.md 2026-09-30 02:11)
  [1188023726335105040460539685827n, true, 18, 18, 224849051972264035718n],
  // NVDAon/USDT (the stock is currency1), same block
  [5243580102571863231091329464n, false, 18, 18, 228298655511218691868n],
  [1188023726335105040460539685827n, true, 18, 6, 224849051972264035718473096178098n],
  [MIN_SQRT_PRICE, false, 18, 18, 340256786698763678858396856460488307819979090561317864144n],
  [MAX_SQRT_PRICE - 1n, true, 18, 18, 340256786836388094070642339899681172762184831912254825631n],
  [MIN_SQRT_PRICE, true, 6, 18, 0n],
];

describe('rwaPriceE18', () => {
  it.each(VECTORS)(
    'sqrtPrice %s (rwa currency0 %s, %i/%i decimals)',
    (sqrt, r0, rd, qd, expected) => {
      expect(rwaPriceE18(sqrt, r0, rd, qd)).toBe(expected);
    },
  );

  it('rejects a zero sqrt price', () => {
    expect(() => rwaPriceE18(0n, true, 18, 18)).toThrow(RangeError);
  });
});

describe('gapPips', () => {
  it('measures against the reference and caps at 100%', () => {
    expect(gapPips(224849100000000000000n, 220000000000000000000n)).toBe(22041n);
    expect(gapPips(10n ** 18n, 3n * 10n ** 18n)).toBe(666666n);
    expect(gapPips(3n * 10n ** 18n, 10n ** 18n)).toBe(1_000_000n);
    expect(() => gapPips(1n, 0n)).toThrow(RangeError);
  });
});

describe('formatting', () => {
  it('prints fees as percentages and 18-decimal amounts as decimals', () => {
    expect(feePercent(500)).toBe('0.05%');
    expect(feePercent(10_000)).toBe('1.00%');
    expect(feePercent(5250)).toBe('0.5250%');
    expect(formatE18(224849051972264035718n)).toBe('224.84');
    expect(formatE18(-1500000000000000000n, 1)).toBe('-1.5');
    expect(formatE18(7n * 10n ** 18n, 0)).toBe('7');
  });
});
