/**
 * /dx (M2-11): what we measured using the Binance Web3 API — calls, latency, result codes and
 * regions from every recorded attempt; the tape's price gap by session, price impact by size and
 * the issuers compared; first sightings of undocumented codes. Each block says how it was measured.
 */
import type { Metadata } from 'next';
import { sessionText } from '../../components/plan-text';
import { Toolbar } from '../../components/Toolbar';
import { BlockTitle, DataTable as Table, Pill, StateBadge } from '../../components/ui';
import { signedPct, timeText } from '../../lib/format';
import { locale } from '../../lib/i18n/server';
import type { T } from '../../lib/i18n/translate';
import { context } from '../../lib/server/context';
import { dxMetrics, dxTape, gapBySession, type DxTape } from '../../lib/server/dx';
import { settle } from '../../lib/server/settle';

export const dynamic = 'force-dynamic';

const DAYS = 7;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: t('dx.title') };
}

/** A horizontal bar per row; values may be negative (bars grow from the middle line). */
function Bars({ rows, unit }: { rows: { label: string; value: number | null; note?: string }[]; unit: string }) {
  const max = Math.max(0.0001, ...rows.map((r) => Math.abs(r.value ?? 0)));
  const diverging = rows.some((r) => (r.value ?? 0) < 0);
  return (
    <ul className="bars">
      {rows.map((row) => {
        const width = row.value === null ? 0 : (Math.abs(row.value) / max) * (diverging ? 50 : 100);
        const left = diverging && row.value !== null && row.value < 0 ? 50 - width : diverging ? 50 : 0;
        return (
          <li key={row.label} className="bar-row">
            <span className="bar-label">{row.label}</span>
            <span className="bar-track" aria-hidden="true">
              {diverging ? <span className="bar-axis" /> : null}
              <span className="bar-fill" style={{ left: `${left}%`, width: `${width}%` }} />
            </span>
            <span className="bar-value">
              {row.value === null ? '—' : `${signedPct(row.value) ?? '0.00'}${unit}`}
              {row.note ? <small>{row.note}</small> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Method({ t, method }: { t: T; method: string }) {
  return <p className="method-note">{t('dx.method', { method })}</p>;
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
  const toolbar = <Toolbar t={t} lang={lang} tz={tz} title={t('dx.title')} />;
  if (!db) {
    return (
      <>
        {toolbar}
        <div className="page-block">
          <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: 'no database' }} now={now} />
        </div>
      </>
    );
  }
  const [metrics, tape] = await Promise.all([
    settle('database', () => dxMetrics(db, DAYS, now)),
    settle('database', () => dxTape(db, DAYS, now)),
  ]);
  const quotes = tape.ok ? tape.value.rows.reduce((sum, r) => sum + r.quotes, 0) : null;
  const total = metrics.ok ? metrics.value.total : null;
  const unavailable = (reason: string) => (
    <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason }} now={now} />
  );
  return (
    <>
      {toolbar}
      <p className="page-intro">
        {t('dx.sub')} {t('common.updated', { time: timeText(now.toISOString(), lang, tz) })} ·{' '}
        {t('dx.window', { days: DAYS })}
      </p>

      <section className="summary-strip four" aria-label={t('dx.title')}>
        {[
          [t('dx.summary.calls'), total ? total.calls.toLocaleString('en-US') : '—'],
          [
            t('dx.summary.error_rate'),
            total && total.calls > 0 ? `${((total.errors / total.calls) * 100).toFixed(1)}%` : '—',
          ],
          [t('dx.summary.p95'), total?.p95Ms !== null && total?.p95Ms !== undefined ? `${total.p95Ms} ms` : '—'],
          [t('dx.summary.tape'), quotes !== null ? quotes.toLocaleString('en-US') : '—'],
        ].map(([label, value]) => (
          <div className="summary-stat" key={String(label)}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>

      <section className="page-block">
        <BlockTitle>{t('dx.endpoints.title')}</BlockTitle>
        {metrics.ok ? (
          metrics.value.endpoints.length > 0 ? (
            <Table
              label={t('dx.endpoints.title')}
              head={[t('dx.col.module'), t('dx.col.endpoint'), t('dx.col.calls'), 'p50', 'p95', t('dx.col.errors'), t('dx.col.codes')]}
              rows={[...metrics.value.endpoints]
                .sort((a, b) => b.calls - a.calls)
                .map((e) => [
                  e.module,
                  <code key="e">{e.endpoint}</code>,
                  e.calls,
                  e.p50Ms ?? '—',
                  e.p95Ms ?? '—',
                  e.errors,
                  <span key="c" className="code-chips">
                    {Object.entries(e.codes).map(([code, n]) => (
                      <Pill key={code} tone={code === '0' ? 'ok' : 'neutral'} icon={false}>
                        {code} × {n}
                      </Pill>
                    ))}
                  </span>,
                ])}
            />
          ) : (
            unavailable('no calls recorded yet')
          )
        ) : (
          unavailable(metrics.reason)
        )}
        {metrics.ok ? <Method t={t} method={metrics.value.method} /> : null}
      </section>

      {metrics.ok && metrics.value.regions.length > 0 ? (
        <section className="page-block">
          <BlockTitle>{t('dx.regions.title')}</BlockTitle>
          <Table
            label={t('dx.regions.title')}
            head={[t('dx.col.region'), t('dx.col.calls'), 'p50', 'p95', t('dx.col.errors')]}
            rows={metrics.value.regions.map((r) => [r.region, r.calls, r.p50Ms ?? '—', r.p95Ms ?? '—', r.errors])}
          />
        </section>
      ) : null}

      <div className="two-blocks">
        <section className="page-block">
          <BlockTitle>{t('dx.tape.gap.title')}</BlockTitle>
          {tape.ok && gapBySession(tape.value.rows).length > 0 ? (
            <Bars
              unit="%"
              rows={gapBySession(tape.value.rows).map((s) => ({
                label: sessionText(t, s.session),
                value: s.gapPct,
                note: `n=${s.samples}`,
              }))}
            />
          ) : (
            unavailable(tape.ok ? 'no tape yet' : tape.reason)
          )}
          {tape.ok ? <Method t={t} method={tape.value.method} /> : null}
        </section>

        <section className="page-block">
          <BlockTitle>{t('dx.tape.impact.title')}</BlockTitle>
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
            unavailable(tape.ok ? 'no tape yet' : tape.reason)
          )}
        </section>
      </div>

      <section className="page-block">
        <BlockTitle>{t('dx.tape.issuers.title')}</BlockTitle>
        {tape.ok && issuers(tape.value.rows).length > 0 ? (
          <Table
            label={t('dx.tape.issuers.title')}
            head={[t('dx.col.issuer'), t('dx.col.quotes'), t('dx.col.quote_errors'), t('dx.col.gap')]}
            rows={issuers(tape.value.rows).map((i) => [
              i.issuer === 'bstocks' ? 'bStocks' : 'Ondo',
              i.quotes,
              `${i.errors} (${i.quotes > 0 ? ((i.errors / i.quotes) * 100).toFixed(1) : '0.0'}%)`,
              i.gap === null ? '—' : `${signedPct(i.gap)}%`,
            ])}
          />
        ) : (
          unavailable(tape.ok ? 'no tape yet' : tape.reason)
        )}
      </section>

      <section className="page-block">
        <BlockTitle>{t('dx.findings.title')}</BlockTitle>
        {metrics.ok ? (
          metrics.value.findings.length > 0 ? (
            <ul className="findings">
              {metrics.value.findings.map((f) => (
                <li key={`${f.kind}:${f.module}:${f.endpoint}:${f.code}`}>
                  <span className="muted">{timeText(f.at, lang, tz)}</span>
                  <Pill tone="wait" icon={false}>
                    {f.kind}
                  </Pill>
                  <code>
                    {f.module} {f.endpoint}
                  </code>
                  <strong>{f.code || '—'}</strong>
                  <span className="muted">{f.meaning}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t('dx.findings.empty')}</p>
          )
        ) : (
          unavailable(metrics.reason)
        )}
      </section>
    </>
  );
}
