/**
 * The interest calculator (DECISIONS D-31, feature F3): what a deposit would earn if today's listed
 * Venus APY held — per day, week, month and year — how many days until that interest reaches the
 * minimum buy, and about how many shares a month of it buys at today's on-chain price.
 *
 * Display only, like supplyApyFromRatePerBlock in packages/core: no decision reads a projection
 * (the agent spends measured interest, SPEC §5.3), so floats are fine here. The rate changes
 * daily; every place that shows this says so (UX_COPY §7.7). Pure: the Earn page's calculator runs
 * it in the browser, GET /api/projection and the MCP tool on the server.
 */

/** A month in the calculator is 30 days. */
export const MONTH_DAYS = 30;

export interface ProjectionInput {
  depositUsd: number;
  /** The listed APY in percent ("3.16" → 3.16), compounded daily. */
  apyPct: number;
  minBuyUsd: number;
  /** On-chain price of one underlying share, USD; null when the tape has none. */
  sharePriceUsd: number | null;
}

export interface Projection {
  /** USD as decimal strings, six decimals, rounded down. */
  perDayUsd: string;
  perWeekUsd: string;
  perMonthUsd: string;
  perYearUsd: string;
  /** Days until the interest first reaches the minimum buy; null at a 0 % rate. */
  daysToMinBuy: number | null;
  /** Shares a month of interest buys at today's price, six decimals, rounded down; null without one. */
  sharesPerMonth: string | null;
}

/**
 * Six decimals, rounded down — after float noise is cut at 12 significant digits, so a value the
 * arithmetic lands a hair under (31.5999999999) reads as what it is (31.600000).
 */
const down6 = (value: number) =>
  (Math.floor(Number((value * 1e6).toPrecision(12))) / 1e6).toFixed(6);
const usable = (value: number) => Number.isFinite(value) && value > 0;

/** Null when the inputs cannot give a number (no deposit, a negative or unreadable rate). */
export function projectInterest(input: ProjectionInput): Projection | null {
  const { depositUsd, apyPct, minBuyUsd, sharePriceUsd } = input;
  if (!usable(depositUsd) || !Number.isFinite(apyPct) || apyPct < 0 || !usable(minBuyUsd)) {
    return null;
  }
  const daily = Math.pow(1 + apyPct / 100, 1 / 365) - 1;
  const earned = (days: number) => depositUsd * (Math.pow(1 + daily, days) - 1);
  const perMonth = earned(MONTH_DAYS);
  // The first whole day on which the interest reaches the minimum; the epsilon keeps an exact
  // boundary (7.0000000001 from rounding) on its day.
  const days = daily > 0 ? Math.log1p(minBuyUsd / depositUsd) / Math.log1p(daily) : null;
  return {
    perDayUsd: down6(earned(1)),
    perWeekUsd: down6(earned(7)),
    perMonthUsd: down6(perMonth),
    perYearUsd: down6(earned(365)),
    daysToMinBuy: days === null ? null : Math.max(1, Math.ceil(days - 1e-9)),
    sharesPerMonth:
      sharePriceUsd !== null && usable(sharePriceUsd) ? down6(perMonth / sharePriceUsd) : null,
  };
}
