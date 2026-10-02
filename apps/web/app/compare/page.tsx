/**
 * /compare (DECISIONS D-31, F2): bStocks against Ondo for one US stock, side by side, from the
 * worker's latest tape run — what each $5 / $50 / $500 quote was worth in shares, the price per
 * share in it, its price impact or the code it was refused with, each token's status, prices and
 * minimum order. Facts with their time; the page never picks for the person.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { AssetBadge } from '../../components/design';
import { Icon } from '../../components/Icon';
import { Toolbar } from '../../components/Toolbar';
import {
  BlockTitle,
  DataTable,
  Ledger,
  Pill,
  SectionHeading,
  StateBadge,
  tapeState,
  Unavailable,
} from '../../components/ui';
import { issuerName, money, sharesText, signedPct } from '../../lib/format';
import { locale } from '../../lib/i18n/server';
import type { T } from '../../lib/i18n/translate';
import { context } from '../../lib/server/context';
import {
  comparableTickers,
  compareIssuers,
  type Comparison,
  type IssuerSide,
} from '../../lib/server/compare';
import { settle } from '../../lib/server/settle';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: t('compare.title') };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value.trim().toUpperCase() : undefined;

function statusTone(side: IssuerSide) {
  if (side.status.reasonCode === 'UNAVAILABLE') return 'skip' as const;
  return side.status.openState === true && side.status.reasonCode === 'TRADING'
    ? ('ok' as const)
    : ('wait' as const);
}

function Side({ t, side }: { t: T; side: IssuerSide }) {
  const name = issuerName(side.issuer) ?? side.issuer;
  const usd = (value: string | null) => (value === null ? '—' : `$${money(value) ?? value}`);
  return (
    // No section label: the table inside carries this name, and one name per landmark (axe).
    <section className="page-block compare-side">
      <BlockTitle
        aside={
          <Pill tone={statusTone(side)}>
            {side.status.reasonMsg
              ? `${side.status.reasonCode} · ${side.status.reasonMsg}`
              : side.status.reasonCode}
          </Pill>
        }
      >
        {name} · {side.symbol}
      </BlockTitle>
      <DataTable
        label={`${name} · ${side.symbol}`}
        head={[
          t('compare.col.size'),
          t('compare.col.shares'),
          t('compare.col.per_share'),
          t('compare.col.impact'),
        ]}
        rows={side.quotes.map((q) => [
          `$${q.sizeUsd}`,
          q.shares === null ? '—' : (sharesText(q.shares) ?? q.shares),
          q.usdPerShare === null ? '—' : `$${q.usdPerShare}`,
          q.errorCode ? (
            <Pill key="e" tone="skip" icon={false} title={q.errorMsg ?? undefined}>
              {t('compare.refused', { code: q.errorCode })}
            </Pill>
          ) : q.priceImpactPct === null ? (
            '—'
          ) : (
            `${q.priceImpactPct}%`
          ),
        ])}
      />
      <Ledger
        rows={[
          [t('compare.price'), usd(side.onchainSharePriceUsd)],
          [t('compare.us'), usd(side.stockPriceUsd)],
          [t('compare.gap'), side.gapPct === null ? '—' : `${signedPct(side.gapPct)}%`],
          [
            t('compare.min'),
            side.venueMinUsd === null ? t('compare.min.none') : usd(side.venueMinUsd),
          ],
          [
            t('compare.address'),
            <code key="a" className="address-full">
              {side.address}
            </code>,
          ],
        ]}
      />
      <p className="method-note">{t('compare.multiplier', { m: side.multiplier })}</p>
    </section>
  );
}

function Verdicts({ t, comparison }: { t: T; comparison: Comparison }) {
  if (comparison.issuers.length < 2) {
    const only = comparison.issuers[0];
    return only ? (
      <p className="page-intro">
        {t('compare.one', {
          issuer: issuerName(only.issuer) ?? only.issuer,
          ticker: comparison.ticker,
        })}
      </p>
    ) : null;
  }
  return (
    <ul className="check-list compare-verdicts">
      {comparison.sizes.map((size) => (
        <li key={size.sizeUsd}>
          <Icon name={size.moreShares ? 'check' : 'minus'} size={18} />
          <span>
            {size.moreShares
              ? t('compare.more', {
                  size: size.sizeUsd,
                  issuer: issuerName(size.moreShares) ?? size.moreShares,
                  // Under 0.005 % two decimals would read "0.00": say "<0.01" instead.
                  pct: Number(size.byPct) < 0.005 ? '<0.01' : signedPct(size.byPct),
                })
              : t('compare.more.none', { size: size.sizeUsd })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function ComparePage({ searchParams }: { searchParams: SearchParams }) {
  const { lang, tz, t } = await locale();
  const { db } = context();
  const now = new Date();
  const toolbar = <Toolbar t={t} lang={lang} tz={tz} title={t('invest.tools')} />;
  const empty = (reason: string) => (
    <>
      {toolbar}
      <section className="empty-state">
        <Unavailable t={t} reason={reason} />
      </section>
    </>
  );
  if (!db) return empty('no database');
  const tickers = await settle('database', () => comparableTickers(db));
  if (!tickers.ok) return empty(tickers.reason);
  const asked = one((await searchParams).ticker);
  const chosen =
    tickers.value.find((x) => x.ticker === asked) ??
    tickers.value.find((x) => x.issuers.length > 1) ??
    tickers.value[0];
  if (!chosen) return empty('registry empty');
  const comparison = await settle('database', () => compareIssuers(db, chosen.ticker, now));
  if (!comparison.ok || !comparison.value) {
    return empty(comparison.ok ? 'registry empty' : comparison.reason);
  }
  const view = comparison.value;
  const data = tapeState(view.data, 'no tape samples yet');

  return (
    <>
      {toolbar}
      <div className="compare-head">
        <SectionHeading title={t('compare.title')} sub={t('compare.sub')} />
        <StateBadge t={t} data={data} now={now} />
      </div>
      <nav className="chips" aria-label={t('compare.pick')}>
        {tickers.value.map((x) => (
          <Link
            key={x.ticker}
            className="chip"
            href={`/compare?ticker=${x.ticker}`}
            aria-current={x.ticker === view.ticker ? 'page' : undefined}
          >
            <AssetBadge ticker={x.ticker} small /> {x.ticker}
          </Link>
        ))}
      </nav>
      <Verdicts t={t} comparison={view} />
      <div className="two-blocks">
        {view.issuers.map((side) => (
          <Side key={side.issuer} t={t} side={side} />
        ))}
      </div>
      <p className="page-intro">{t('compare.note')}</p>
      <div className="link-row page-links">
        <Link className="text-link" href={`/check?ticker=${view.ticker}`}>
          {t('compare.cta.check')}
          <Icon name="arrow" size={16} />
        </Link>
        <a className="text-link" href={`/api/compare?ticker=${view.ticker}`}>
          GET /api/compare?ticker={view.ticker}
        </a>
      </div>
    </>
  );
}
