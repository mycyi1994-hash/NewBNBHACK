/**
 * The interest calculator (DECISIONS D-31, feature F3): what a deposit would earn if today's listed
 * Venus APY held — per day, week, month and year — how many days until that interest reaches the
 * first buy, and about how many shares a month of it buys at today's on-chain price.
 *
 * Display only, like supplyApyFromRatePerBlock in packages/core: no decision reads a projection
 * (the agent spends measured interest, SPEC §5.3), so floats are fine here. The rate changes
 * daily; every place that shows this says so (UX_COPY §7.7). Pure: the Earn page's calculator runs
 * it in the browser, GET /api/projection and the MCP tool on the server.
 */

/** A month in the calculator is 30 days. */
export const MONTH_DAYS = 30;

/** What the calculator starts with when there is no principal on record to start from. */
export const DEFAULT_DEPOSIT_USD = '100';

export interface ProjectionInput {
  depositUsd: number;
  /** The listed APY in percent ("3.16" → 3.16), compounded daily. */
  apyPct: number;
  /** The first buy: the minimum buy, or the token's venue minimum when that is higher. */
  firstBuyUsd: number;
  /** On-chain price of one underlying share, USD; null when there is no live one. */
  sharePriceUsd: number | null;
}

export interface Projection {
  /** USD as decimal strings with six decimals, rounded down (to the cent from $1,000 up). */
  perDayUsd: string;
  perWeekUsd: string;
  perMonthUsd: string;
  perYearUsd: string;
  /** Days until the interest first reaches the first buy; null at a 0 % rate. */
  daysToFirstBuy: number | null;
  /** Shares a month of interest buys at today's price, six decimals, rounded down; null without one. */
  sharesPerMonth: string | null;
}

/**
 * Rounded down to six decimals — to the cent from 1,000 up, where a float's last digits are noise.
 * A relative nudge of 1e-12 first, so a value the arithmetic lands a hair under (31.5999999999998)
 * reads as what it is (31.600000) and nothing real is rounded up.
 */
function down(value: number): string {
  const scale = value >= 1000 ? 100 : 1e6;
  return (Math.floor(value * scale * (1 + 1e-12)) / scale).toFixed(6);
}

const usable = (value: number) => Number.isFinite(value) && value > 0;

/** Null when the inputs cannot give a number (no deposit, a negative or unreadable rate). */
export function projectInterest(input: ProjectionInput): Projection | null {
  const { depositUsd, apyPct, firstBuyUsd, sharePriceUsd } = input;
  if (!usable(depositUsd) || !Number.isFinite(apyPct) || apyPct < 0 || !usable(firstBuyUsd)) {
    return null;
  }
  // ln(1 + APY) per year; (1 + APY)^(days / 365) − 1 through expm1/log1p stays exact for small rates.
  const yearly = Math.log1p(apyPct / 100);
  const earned = (days: number) => depositUsd * Math.expm1((yearly * days) / 365);
  const perMonth = earned(MONTH_DAYS);
  // The first whole day on which the interest reaches the first buy; the epsilon keeps an exact
  // boundary (7.0000000001 from rounding) on its day.
  const days = yearly > 0 ? (Math.log1p(firstBuyUsd / depositUsd) * 365) / yearly : null;
  return {
    perDayUsd: down(earned(1)),
    perWeekUsd: down(earned(7)),
    perMonthUsd: down(perMonth),
    perYearUsd: down(earned(365)),
    daysToFirstBuy: days === null ? null : Math.max(1, Math.ceil(days - 1e-9)),
    sharesPerMonth:
      sharePriceUsd !== null && usable(sharePriceUsd) ? down(perMonth / sharePriceUsd) : null,
  };
}

/** The first buy for a token: the larger of the minimum buy and the venue's minimum order. */
export function firstBuyUsd(minBuyUsd: string, venueMinUsd: string | null): string {
  return venueMinUsd !== null && Number(venueMinUsd) > Number(minBuyUsd) ? venueMinUsd : minBuyUsd;
}

/**
 * The calculator's opening amount: the plan's principal cut to the cent and written plainly
 * ("1000", "4.99"), or DEFAULT_DEPOSIT_USD when there is none — never 0, which would open on an
 * error (an unfunded house plan has principal 0).
 */
export function startingDeposit(principalUsd: string | null | undefined): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(principalUsd?.trim() ?? '');
  if (!match) return DEFAULT_DEPOSIT_USD;
  const whole = (match[1] ?? '0').replace(/^0+(?=\d)/, '');
  const cents = (match[2] ?? '').slice(0, 2).replace(/0+$/, '');
  const text = cents ? `${whole}.${cents}` : whole;
  return Number(text) > 0 ? text : DEFAULT_DEPOSIT_USD;
}
