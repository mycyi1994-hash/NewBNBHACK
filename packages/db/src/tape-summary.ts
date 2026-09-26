/**
 * Tape aggregates for /dx (TASKS M2-11, DX_PROTOCOL §3.4): per US session, quote size and issuer —
 * how often quotes failed, the average price impact, and the average gap between the on-chain
 * price per share (token price ÷ multiplier) and the independent US price, where one existed.
 * Numbers come back as text; the page shows them, it never computes money from them.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './index.js';

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
