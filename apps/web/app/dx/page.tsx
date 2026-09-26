/**
 * /dx (M2-11): what we measured using the Binance Web3 API — calls, latency, result codes and
 * regions from every recorded attempt; the tape's price gap by session, price impact by size and
 * the issuers compared; first sightings of undocumented codes. Each block says how it was measured.
 */
import type { ReactNode } from 'react';
import { Card, Pill, SectionTitle, StateBadge } from '../../components/ui';
import { signedPct, timeText } from '../../lib/format';
import { locale } from '../../lib/i18n/server';
import type { T } from '../../lib/i18n/translate';
import { context } from '../../lib/server/context';
import { dxMetrics, dxTape, gapBySession, type DxTape } from '../../lib/server/dx';
import { settle } from '../../lib/server/settle';

export const dynamic = 'force-dynamic';

const DAYS = 7;

function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="num w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-2 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-2 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A horizontal bar per row; values may be negative (bars grow from the middle line). */
function Bars({ rows, unit }: { rows: { label: string; value: number | null; note?: string }[]; unit: string }) {
  const max = Math.max(0.0001, ...rows.map((r) => Math.abs(r.value ?? 0)));
  const diverging = rows.some((r) => (r.value ?? 0) < 0);
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const width = row.value === null ? 0 : (Math.abs(row.value) / max) * (diverging ? 50 : 100);
        const left = diverging && row.value !== null && row.value < 0 ? 50 - width : diverging ? 50 : 0;
        return (
          <li key={row.label} className="grid grid-cols-[7rem_1fr_6rem] items-center gap-2 text-sm">
            <span className="truncate text-muted">{row.label}</span>
            <span className="relative h-3 rounded-full bg-canvas" aria-hidden="true">
              {diverging ? <span className="absolute inset-y-0 left-1/2 w-px bg-line" /> : null}
              <span className="absolute inset-y-0 rounded-full bg-brand" style={{ left: `${left}%`, width: `${width}%` }} />
            </span>
            <span className="num text-right font-medium">
              {row.value === null ? '—' : `${signedPct(row.value) ?? '0.00'}${unit}`}
              {row.note ? <span className="ml-1 text-xs text-muted">{row.note}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Method({ t, method }: { t: T; method: string }) {
  return <p className="mt-3 text-xs text-muted">{t('dx.method', { method })}</p>;
}

function sessionName(t: T, session: string): string {
  switch (session) {
    case 'regular':
    case 'pre':
    case 'post':
    case 'overnight':
    case 'weekend':
    case 'holiday':
      return t(`dx.session.${session}`);
    default:
      return session;
  }
}

function impactBySize(rows: DxTape['rows']) {
  const out = new Map<string, { sum: number; n: number }>();
  for (const row of rows) {
    if (row.avgImpactPct === null) continue;
    const key = `${row.issuer}:${row.sizeUsd}`;
    const quotes = row.quotes - row.quoteErrors;
    const entry = out.get(key) ?? { sum: 0, n: 0 };
    out.set(key, { sum: entry.sum + Number(row.avgImpactPct) * quotes, n: entry.n + quotes });
  }
  return [...out.entries()]
    .map(([key, { sum, n }]) => {
      const [issuer = '', size = '0'] = key.split(':');
      return { issuer, size: Number(size), impact: n > 0 ? sum / n : null, quotes: n };
    })
    .sort((a, b) => a.issuer.localeCompare(b.issuer) || a.size - b.size);
}

function issuers(rows: DxTape['rows']) {
  const out = new Map<string, { quotes: number; errors: number; gapSum: number; gapN: number }>();
  for (const row of rows) {
    const entry = out.get(row.issuer) ?? { quotes: 0, errors: 0, gapSum: 0, gapN: 0 };
    entry.quotes += row.quotes;
    entry.errors += row.quoteErrors;
    if (row.avgGapPct !== null) {
      entry.gapSum += Number(row.avgGapPct) * row.gapSamples;
      entry.gapN += row.gapSamples;
    }
    out.set(row.issuer, entry);
  }
  return [...out.entries()].map(([issuer, e]) => ({
    issuer,
    quotes: e.quotes,
    errors: e.errors,
    gap: e.gapN > 0 ? e.gapSum / e.gapN : null,
  }));
}

export default async function DxPage() {
  const { lang, tz, t } = await locale();
  const { db } = context();
  const now = new Date();
  if (!db) return <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: 'no database' }} now={now} />;
  const [metrics, tape] = await Promise.all([
    settle('database', () => dxMetrics(db, DAYS, now)),
    settle('database', () => dxTape(db, DAYS, now)),
  ]);
  const quotes = tape.ok ? tape.value.rows.reduce((sum, r) => sum + r.quotes, 0) : null;
  const total = metrics.ok ? metrics.value.total : null;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-extrabold">{t('dx.title')}</h1>
        <p className="mt-2 text-muted">{t('dx.sub')}</p>
        <p className="mt-1 text-sm text-muted">
          {t('common.updated', { time: timeText(now.toISOString(), lang, tz) })} ·{' '}
          {t('dx.window', { days: DAYS })}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [t('dx.summary.calls'), total ? total.calls.toLocaleString('en-US') : '—'],
          [
            t('dx.summary.error_rate'),
            total && total.calls > 0 ? `${((total.errors / total.calls) * 100).toFixed(1)}%` : '—',
          ],
          [t('dx.summary.p95'), total?.p95Ms !== null && total?.p95Ms !== undefined ? `${total.p95Ms} ms` : '—'],
          [t('dx.summary.tape'), quotes !== null ? quotes.toLocaleString('en-US') : '—'],
        ].map(([label, value]) => (
          <Card key={String(label)} className="!p-4">
            <div className="text-sm text-muted">{label}</div>
            <div className="num mt-1 text-2xl font-bold">{value}</div>
          </Card>
        ))}
      </div>

      <Card>
        <SectionTitle>{t('dx.endpoints.title')}</SectionTitle>
        {metrics.ok ? (
          metrics.value.endpoints.length > 0 ? (
            <Table
              head={[t('dx.col.module'), t('dx.col.endpoint'), t('dx.col.calls'), 'p50', 'p95', t('dx.col.errors'), t('dx.col.codes')]}
              rows={[...metrics.value.endpoints]
                .sort((a, b) => b.calls - a.calls)
                .map((e) => [
                  e.module,
                  <code key="e" className="text-xs">
                    {e.endpoint}
                  </code>,
                  e.calls,
                  e.p50Ms ?? '—',
                  e.p95Ms ?? '—',
                  e.errors,
                  <span key="c" className="flex flex-wrap gap-1">
                    {Object.entries(e.codes).map(([code, n]) => (
                      <Pill key={code} tone={code === '0' ? 'ok' : 'neutral'} icon={false}>
                        {code} × {n}
                      </Pill>
                    ))}
                  </span>,
                ])}
            />
          ) : (
            <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: 'no calls recorded yet' }} now={now} />
          )
        ) : (
          <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: metrics.reason }} now={now} />
        )}
        {metrics.ok ? <Method t={t} method={metrics.value.method} /> : null}
      </Card>

      {metrics.ok && metrics.value.regions.length > 0 ? (
        <Card>
          <SectionTitle>{t('dx.regions.title')}</SectionTitle>
          <Table
            head={[t('dx.col.region'), t('dx.col.calls'), 'p50', 'p95', t('dx.col.errors')]}
            rows={metrics.value.regions.map((r) => [r.region, r.calls, r.p50Ms ?? '—', r.p95Ms ?? '—', r.errors])}
          />
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionTitle>{t('dx.tape.gap.title')}</SectionTitle>
          {tape.ok && gapBySession(tape.value.rows).length > 0 ? (
            <Bars
              unit="%"
              rows={gapBySession(tape.value.rows).map((s) => ({
                label: sessionName(t, s.session),
                value: s.gapPct,
                note: `n=${s.samples}`,
              }))}
            />
          ) : (
            <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: tape.ok ? 'no tape yet' : tape.reason }} now={now} />
          )}
          {tape.ok ? <Method t={t} method={tape.value.method} /> : null}
        </Card>

        <Card>
          <SectionTitle>{t('dx.tape.impact.title')}</SectionTitle>
          {tape.ok && impactBySize(tape.value.rows).length > 0 ? (
            <Bars
              unit="%"
              rows={impactBySize(tape.value.rows).map((r) => ({
                label: `${r.issuer === 'bstocks' ? 'bStocks' : 'Ondo'} $${r.size}`,
                value: r.impact,
                note: `n=${r.quotes}`,
              }))}
            />
          ) : (
            <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: tape.ok ? 'no tape yet' : tape.reason }} now={now} />
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle>{t('dx.tape.issuers.title')}</SectionTitle>
        {tape.ok && issuers(tape.value.rows).length > 0 ? (
          <Table
            head={[t('dx.col.issuer'), t('dx.col.quotes'), t('dx.col.quote_errors'), t('dx.col.gap')]}
            rows={issuers(tape.value.rows).map((i) => [
              i.issuer === 'bstocks' ? 'bStocks' : 'Ondo',
              i.quotes,
              `${i.errors} (${i.quotes > 0 ? ((i.errors / i.quotes) * 100).toFixed(1) : '0.0'}%)`,
              i.gap === null ? '—' : `${signedPct(i.gap)}%`,
            ])}
          />
        ) : (
          <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: tape.ok ? 'no tape yet' : tape.reason }} now={now} />
        )}
      </Card>

      <Card>
        <SectionTitle>{t('dx.findings.title')}</SectionTitle>
        {metrics.ok ? (
          metrics.value.findings.length > 0 ? (
            <ul className="flex flex-col gap-2 text-sm">
              {metrics.value.findings.map((f) => (
                <li key={`${f.kind}:${f.module}:${f.endpoint}:${f.code}`} className="flex flex-wrap items-center gap-2">
                  <span className="num text-muted">{timeText(f.at, lang, tz)}</span>
                  <Pill tone="wait" icon={false}>
                    {f.kind}
                  </Pill>
                  <code className="text-xs">
                    {f.module} {f.endpoint}
                  </code>
                  <span className="font-semibold">{f.code || '—'}</span>
                  <span className="text-muted">{f.meaning}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">{t('dx.findings.empty')}</p>
          )
        ) : (
          <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: metrics.reason }} now={now} />
        )}
      </Card>
    </div>
  );
}
