/**
 * Amount maths (SPEC §5.3): exact bigint arithmetic on token units, decimal strings at the edges.
 * No floats touch money. Pure, no I/O.
 */

const TEN = 10n;

/** "12.345" with 18 decimals → 12345000000000000000n. Rejects more fractional digits than allowed. */
export function toUnits(amount: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error(`not a non-negative decimal: ${amount}`);
  const [, whole = '0', frac = ''] = match;
  if (frac.length > decimals) throw new Error(`${amount} has more than ${decimals} decimals`);
  return BigInt(whole) * TEN ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** 12345000000000000000n with 18 decimals → "12.345" (trailing zeros trimmed). */
export function fromUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = TEN ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Venus/Compound: underlying = vTokens × exchangeRate / 1e18. `exchangeRateStored` is already
 * scaled by 1e(18 + underlyingDecimals − vTokenDecimals), so the result is in underlying units.
 * Rounds down, like the protocol.
 */
export function underlyingFromVTokens(vTokens: bigint, exchangeRate: bigint): bigint {
  return (vTokens * exchangeRate) / 10n ** 18n;
}

/** vTokens minted for a deposit of `underlying` units at `exchangeRate` (rounds down). */
export function vTokensForUnderlying(underlying: bigint, exchangeRate: bigint): bigint {
  if (exchangeRate <= 0n) throw new Error('exchange rate must be positive');
  return (underlying * 10n ** 18n) / exchangeRate;
}

/**
 * Compound utilisation = borrows / (cash + borrows − reserves), in basis points (0–10000).
 * Returns 0 for an empty market.
 */
export function utilizationBps(cash: bigint, borrows: bigint, reserves: bigint): number {
  const supplied = cash + borrows - reserves;
  if (borrows === 0n || supplied <= 0n) return 0;
  return Number((borrows * 10_000n) / supplied);
}

/**
 * Yield-mode interest (SPEC §5.3): position − principal − already harvested, all in underlying
 * units. Never negative: a position below principal (rounding, bad debt) means no interest to spend.
 */
export function interestUnits(position: bigint, principal: bigint, harvested: bigint): bigint {
  const interest = position - principal - harvested;
  return interest > 0n ? interest : 0n;
}

/**
 * Supply APY from Venus `supplyRatePerBlock` (1e18-scaled), compounded per block for a year:
 * (1 + rate)^blocksPerYear − 1. Display only — decisions use measured interest, not APY.
 */
export function supplyApyFromRatePerBlock(ratePerBlock: bigint, blocksPerYear: number): number {
  const rate = Number(ratePerBlock) / 1e18;
  return Math.pow(1 + rate, blocksPerYear) - 1;
}
