/**
 * Holdings (SPEC §5.9, TASKS M1-08): users see shares, not tokens. shares = tokens × multiplier,
 * where the multiplier is bStocks' on-chain uiMultiplier or Ondo's tokenToShareRatio. bStocks keep
 * `balanceOf` fixed through dividends and splits and move the multiplier instead, so a holding is
 * revalued whenever the multiplier changes.
 */
import { fromUnits, toUnits } from './amounts.js';

const MULTIPLIER_DECIMALS = 18;
const ONE = 10n ** 18n;

/** Token base units (with the token's `decimals`) × multiplier → shares, rounded down. */
export function sharesFromTokens(tokenUnits: bigint, decimals: number, multiplier: string): string {
  const shareUnits = (tokenUnits * toUnits(multiplier, MULTIPLIER_DECIMALS)) / ONE;
  return fromUnits(shareUnits, decimals);
}

/** Numeric equality of two multiplier strings ("1.0" equals "1"). */
export function sameMultiplier(a: string, b: string): boolean {
  return toUnits(a, MULTIPLIER_DECIMALS) === toUnits(b, MULTIPLIER_DECIMALS);
}

export interface HoldingSnapshot {
  /** Base units. */
  tokens: string;
  decimals: number;
  multiplierAtLastUpdate: string;
}

/** Shares at the current multiplier, and whether it moved since the holding was last written. */
export function revalueHolding(
  holding: HoldingSnapshot,
  currentMultiplier: string,
): { shares: string; multiplierChanged: boolean } {
  return {
    shares: sharesFromTokens(BigInt(holding.tokens), holding.decimals, currentMultiplier),
    multiplierChanged: !sameMultiplier(holding.multiplierAtLastUpdate, currentMultiplier),
  };
}

export interface PendingMultiplierChange {
  from: string;
  to: string;
  effectiveAt: string;
}

/**
 * A scheduled bStocks multiplier change (`newUIMultiplier` taking effect at `effectiveAt`, unix
 * seconds; 0 means none), or null when nothing is pending.
 */
export function upcomingMultiplierChange(
  current: string,
  next: string,
  effectiveAtSec: number,
  now: Date,
): PendingMultiplierChange | null {
  if (effectiveAtSec <= 0 || effectiveAtSec * 1000 <= now.getTime()) return null;
  if (sameMultiplier(current, next)) return null;
  return { from: current, to: next, effectiveAt: new Date(effectiveAtSec * 1000).toISOString() };
}
