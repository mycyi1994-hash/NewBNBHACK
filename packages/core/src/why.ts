/**
 * The one-line "why" behind every cycle (UX_COPY §4, plus the §7 drafts). Keys here must match
 * the copy exactly — the engine may not invent copy; `why.test.ts` compares the two. Params are
 * display strings.
 */
import { fromUnits } from './amounts.js';

export const WHY_KEYS = [
  'why.bought.regular',
  'why.bought.anytime',
  'why.bought.interest',
  'why.deferred.market_closed',
  'why.deferred.price_gap',
  'why.deferred.quote_impact',
  'why.skipped.below_min',
  'why.skipped.corporate_action.earnings',
  'why.skipped.corporate_action.cash_dividend',
  'why.skipped.corporate_action.stock_split',
  'why.skipped.daily_cap',
  'why.skipped.guardian',
  'why.skipped.no_liquidity',
  'why.failed.simulation',
  'why.failed.onchain',
  // UX_COPY §7 agent drafts, pending human review (DECISIONS D-20).
  'why.data.stale',
  'why.data.unavailable',
  'why.skipped.guardian.hold',
  'why.skipped.venue_minimum',
] as const;

export type WhyKey = (typeof WHY_KEYS)[number];

export interface Why {
  key: WhyKey;
  params: Readonly<Record<string, string>>;
}

const USD_SCALE = 10n ** 16n; // 18-decimal units → cents

/** 18-decimal USD units → "5.00". Truncates, so an amount is never shown larger than it is. */
export function formatUsd(units: bigint): string {
  const cents = units / USD_SCALE;
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** 18-decimal share units → at most 6 decimals, trailing zeros trimmed; tiny amounts keep all. */
export function formatShares(units: bigint): string {
  const six = units - (units % 10n ** 12n);
  return six === 0n && units !== 0n ? fromUnits(units, 18) : fromUnits(six, 18);
}

/** A percentage for copy: two decimals, sign kept ("-0.35"), never "-0.00". */
export function formatPct(value: number): string {
  const text = value.toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}
