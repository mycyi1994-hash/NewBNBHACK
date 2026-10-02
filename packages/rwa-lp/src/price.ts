/**
 * The hook's price arithmetic in TypeScript (contracts/libraries/PoolPriceMath.sol), for reading a
 * pool without trusting a UI-side float. Every step floors exactly like FullMath.mulDiv, so the
 * results equal the contract's to the wei; price.test.ts and PoolPriceMath.t.sol share vectors.
 */
const Q96 = 2n ** 96n;

/** USD value of one whole RWA token (18 decimals) implied by a pool's sqrt price. */
export function rwaPriceE18(
  sqrtPriceX96: bigint,
  rwaIsCurrency0: boolean,
  rwaDecimals: number,
  quoteDecimals: number,
): bigint {
  if (sqrtPriceX96 <= 0n) throw new RangeError('sqrtPriceX96 must be positive');
  const rwaUnit = 10n ** BigInt(18 + rwaDecimals);
  const quoteUnit = 10n ** BigInt(quoteDecimals);
  if (rwaIsCurrency0) {
    const priceX96 = (sqrtPriceX96 * sqrtPriceX96) / Q96;
    return (priceX96 * rwaUnit) / (Q96 * quoteUnit);
  }
  const inverseX96 = (Q96 * Q96) / sqrtPriceX96;
  return (inverseX96 * rwaUnit) / (sqrtPriceX96 * quoteUnit);
}

/** |price − reference| / reference in hundredths of a bip (1_000_000 = 100%), capped at 100%. */
export function gapPips(priceE18: bigint, referenceE18: bigint): bigint {
  if (referenceE18 <= 0n) throw new RangeError('referenceE18 must be positive');
  const gap = priceE18 > referenceE18 ? priceE18 - referenceE18 : referenceE18 - priceE18;
  if (gap >= referenceE18) return 1_000_000n;
  return (gap * 1_000_000n) / referenceE18;
}

/** A Uniswap v4 fee (hundredths of a bip) as a percentage string: 500 → "0.05%". */
export function feePercent(pips: number): string {
  return `${(pips / 10_000).toFixed(pips % 100 === 0 ? 2 : 4)}%`;
}

/** An 18-decimal amount as a decimal string with `digits` fraction digits (truncated). */
export function formatE18(value: bigint, digits = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** 18n;
  const fraction = (abs % 10n ** 18n).toString().padStart(18, '0').slice(0, digits);
  return `${negative ? '-' : ''}${whole}${digits > 0 ? `.${fraction}` : ''}`;
}
