/**
 * Tape aggregates for /dx (TASKS M2-11, DX_PROTOCOL §3.4): per US session, quote size and issuer —
 * how often quotes failed, the average price impact, and the average gap between the on-chain
 * price per share (token price ÷ multiplier) and the independent US price, where one existed.
 * Numbers come back as text; the page shows them, it never computes money from them.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './index.js';

/** How the tape is recorded, stated wherever its numbers are shown (/dx, dx/tape-summary.md). */
export const TAPE_METHOD =
  'every 10 minutes the worker quotes $5/$50/$500 USDT → each registered token (never executed) and records the RWA status, token price and the independent US price (RWA Dynamic V2 stockInfo.price); gap = (token price ÷ multiplier) ÷ US price − 1, only where a US price existed';

export interface TapeSummaryRow {
  session: string;
  sizeUsd: number;
  issuer: string;
  quotes: number;
  quoteErrors: number;
  avgImpactPct: string | null;
  avgGapPct: string | null;
  gapSamples: number;
}

export async function tapeSummary(db: Db, since: Date): Promise<TapeSummaryRow[]> {
  const rows = await db.execute<{
    session: string;
    size_usd: number;
    issuer: string;
    quotes: string;
    quote_errors: string;
    avg_impact_pct: string | null;
    avg_gap_pct: string | null;
    gap_samples: string;
  }>(sql`
    select
      t.session,
      t.size_usd,
      split_part(t.instrument_id, ':', 2) as issuer,
      count(*)::text as quotes,
      (count(*) filter (where t.error_code is not null))::text as quote_errors,
      round(avg(t.price_impact_pct::numeric) filter (where t.error_code is null and t.price_impact_pct ~ '^-?[0-9.]+$'), 4)::text as avg_impact_pct,
      round(avg((t.token_price::numeric / nullif(i.multiplier::numeric, 0) / nullif(t.stock_price::numeric, 0) - 1) * 100)
        filter (where t.stock_price ~ '^[0-9.]+$' and t.token_price ~ '^[0-9.]+$'), 4)::text as avg_gap_pct,
      (count(*) filter (where t.stock_price ~ '^[0-9.]+$' and t.token_price ~ '^[0-9.]+$'))::text as gap_samples
    from tape_samples t
    join instruments i on i.id = t.instrument_id
    where t.sampled_at >= ${since.toISOString()}
    group by 1, 2, 3
    order by 1, 2, 3`);
  return rows.map((r) => ({
    session: r.session,
    sizeUsd: Number(r.size_usd),
    issuer: r.issuer,
    quotes: Number(r.quotes),
    quoteErrors: Number(r.quote_errors),
    avgImpactPct: r.avg_impact_pct,
    avgGapPct: r.avg_gap_pct,
    gapSamples: Number(r.gap_samples),
  }));
}

/** The far end of a window: the queries below take [since, until). */
const FAR_FUTURE = new Date('9999-01-01T00:00:00Z');

/** Gap in percent of one row, where both prices are plain decimals (SQL, shared by the queries). */
const GAP_PCT = sql`(t.token_price::numeric / nullif(i.multiplier::numeric, 0) / nullif(t.stock_price::numeric, 0) - 1) * 100`;
const HAS_PRICES = sql`t.stock_price ~ '^[0-9.]+$' and t.token_price ~ '^[0-9.]+$'`;

export interface TapeCoverage {
  /** Tape runs (one per 10-minute slot), rows (token × size), and tokens seen. */
  runs: number;
  rows: number;
  tokens: number;
  first: string | null;
  last: string | null;
  /** Runs per session of our own US-equities clock. */
  bySession: { session: string; runs: number }[];
}

/** What the window holds: how many runs, rows and tokens, from when to when, per session. */
export async function tapeCoverage(db: Db, since: Date, until = FAR_FUTURE): Promise<TapeCoverage> {
  const window = sql`t.sampled_at >= ${since.toISOString()} and t.sampled_at < ${until.toISOString()}`;
  const [totals] = await db.execute<{
    runs: string;
    rows: string;
    tokens: string;
    first: string | null;
    last: string | null;
  }>(sql`
    select count(distinct t.slot_at)::text as runs, count(*)::text as rows,
      count(distinct t.instrument_id)::text as tokens,
      to_char(min(t.sampled_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as first,
      to_char(max(t.sampled_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last
    from tape_samples t where ${window}`);
  const sessions = await db.execute<{ session: string; runs: string }>(sql`
    select t.session, count(distinct t.slot_at)::text as runs
    from tape_samples t where ${window} group by 1 order by 1`);
  return {
    runs: Number(totals?.runs ?? 0),
    rows: Number(totals?.rows ?? 0),
    tokens: Number(totals?.tokens ?? 0),
    first: totals?.first ?? null,
    last: totals?.last ?? null,
    bySession: sessions.map((r) => ({ session: r.session, runs: Number(r.runs) })),
  };
}

export interface TapeCodeRow {
  issuer: string;
  session: string;
  code: string;
  /** Quotes refused with this code. */
  count: number;
  /** One message the API sent with it, as recorded. */
  message: string | null;
}

/** The codes quotes were refused with, per issuer and session, most frequent first. */
export async function tapeErrorCodes(
  db: Db,
  since: Date,
  until = FAR_FUTURE,
): Promise<TapeCodeRow[]> {
  const rows = await db.execute<{
    issuer: string;
    session: string;
    code: string;
    count: string;
    message: string | null;
  }>(sql`
    select split_part(t.instrument_id, ':', 2) as issuer, t.session, t.error_code as code,
      count(*)::text as count, min(t.error_msg) as message
    from tape_samples t
    where t.sampled_at >= ${since.toISOString()} and t.sampled_at < ${until.toISOString()}
      and t.error_code is not null
    group by 1, 2, 3
    order by count(*) desc, 1, 2, 3`);
  return rows.map((r) => ({
    issuer: r.issuer,
    session: r.session,
    code: r.code,
    count: Number(r.count),
    message: r.message,
  }));
}

export interface TapeStatusRow {
  issuer: string;
  /** statusInfo.reasonCode and reasonMsg as the RWA list returned them. */
  reasonCode: string | null;
  reasonMsg: string | null;
  /** Token-runs (one token in one run) with this status. */
  tokenRuns: number;
}

/** How often each token status was seen (trading, corporate actions, halts), per issuer. */
export async function tapeStatusCodes(
  db: Db,
  since: Date,
  until = FAR_FUTURE,
): Promise<TapeStatusRow[]> {
  const rows = await db.execute<{
    issuer: string;
    reason_code: string | null;
    reason_msg: string | null;
    token_runs: string;
  }>(sql`
    select split_part(t.instrument_id, ':', 2) as issuer, t.reason_code, t.reason_msg,
      count(distinct (t.slot_at, t.instrument_id))::text as token_runs
    from tape_samples t
    where t.sampled_at >= ${since.toISOString()} and t.sampled_at < ${until.toISOString()}
    group by 1, 2, 3
    order by count(distinct (t.slot_at, t.instrument_id)) desc, 1, 2, 3`);
  return rows.map((r) => ({
    issuer: r.issuer,
    reasonCode: r.reason_code,
    reasonMsg: r.reason_msg,
    tokenRuns: Number(r.token_runs),
  }));
}

export interface TapeGapRow {
  issuer: string;
  session: string;
  /** Token-runs with both prices (the sizes of one run share a price, so they count once). */
  samples: number;
  medianGapPct: string | null;
  p90AbsGapPct: string | null;
}

/** The gap's median and its 90th percentile in absolute value, per issuer and session. */
export async function tapeGapPercentiles(
  db: Db,
  since: Date,
  until = FAR_FUTURE,
): Promise<TapeGapRow[]> {
  const rows = await db.execute<{
    issuer: string;
    session: string;
    samples: string;
    median_gap_pct: string | null;
    p90_abs_gap_pct: string | null;
  }>(sql`
    with g as (
      select distinct t.slot_at, t.instrument_id, split_part(t.instrument_id, ':', 2) as issuer,
        t.session, ${GAP_PCT} as gap
      from tape_samples t join instruments i on i.id = t.instrument_id
      where t.sampled_at >= ${since.toISOString()} and t.sampled_at < ${until.toISOString()}
        and ${HAS_PRICES}
    )
    select issuer, session, count(*)::text as samples,
      round((percentile_cont(0.5) within group (order by gap))::numeric, 4)::text as median_gap_pct,
      round((percentile_cont(0.9) within group (order by abs(gap)))::numeric, 4)::text as p90_abs_gap_pct
    from g where gap is not null
    group by 1, 2 order by 1, 2`);
  return rows.map((r) => ({
    issuer: r.issuer,
    session: r.session,
    samples: Number(r.samples),
    medianGapPct: r.median_gap_pct,
    p90AbsGapPct: r.p90_abs_gap_pct,
  }));
}
