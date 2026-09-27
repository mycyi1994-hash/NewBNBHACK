/**
 * Receipt details (the approved design's receipt page) for one cycle: what it did and why, the
 * money that paid for it, the shares received, its on-chain receipts and every step it logged.
 * A dry run or a wait says so; nothing on this page is an example.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eventTitle, ReceiptLinks } from '../../../components/activity/items';
import { Trace } from '../../../components/activity/Trace';
import { MoneyFlow } from '../../../components/design';
import { Icon } from '../../../components/Icon';
import { planName } from '../../../components/plan-text';
import { Toolbar } from '../../../components/Toolbar';
import { CheckBadge, Ledger, outcomeText, Unavailable, whyText } from '../../../components/ui';
import { issuerName, money, moneyFine, sharesText, timeText } from '../../../lib/format';
import { locale } from '../../../lib/i18n/server';
import { cycleDetail } from '../../../lib/server/activity';
import { context } from '../../../lib/server/context';
import { settle } from '../../../lib/server/settle';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: t('receipt.details.title') };
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) notFound();
  const { lang, tz, t } = await locale();
  const { db } = context();
  const back = { href: '/activity', label: t('nav.activity') };
  const toolbar = (
    <Toolbar t={t} lang={lang} tz={tz} title={t('receipt.details.title')} back={back} />
  );
  const detail = db
    ? await settle('database', () => cycleDetail(db, Number(id)))
    : ({ ok: false, reason: 'no database' } as const);
  if (!detail.ok) {
    return (
      <>
        {toolbar}
        <section className="empty-state">
          <Unavailable t={t} reason={detail.reason} />
        </section>
      </>
    );
  }
  if (!detail.value) notFound();
  const { item, steps, finishedAt } = detail.value;
  const ticker = item.plan?.ticker ?? '';
  const bought = item.kind === 'BOUGHT';
  const interest = item.interestUsd !== null;
  const why = whyText(t, lang, tz, item.why);
  const simulated = item.executionMode === 'simulate' || item.kind === 'SIMULATED';
  const title = bought
    ? interest
      ? t('receipt.doc.interest')
      : t('receipt.doc.contribution')
    : eventTitle(t, item);
  const source = interest ? item.interestUsd : item.spendUsd;
  return (
    <>
      {toolbar}
      <div className="receipt-detail-grid">
        <section className="receipt-document">
          <div className="document-meta">
            <span>{outcomeText(t, item.kind)}</span>
            <span>{timeText(item.at, lang, tz)}</span>
          </div>
          <div className="document-title">
            <h2>{title}</h2>
            {item.kind === 'FAILED' ? (
              <span className="check-badge fail" aria-hidden="true" />
            ) : (
              <CheckBadge waiting={!bought} />
            )}
          </div>
          <p className="document-subtitle">
            {why ??
              (item.kind === 'SIMULATED' && item.spendUsd && item.shares
                ? t('judge.preview.line', {
                    usd: money(item.spendUsd),
                    ticker,
                    shares: sharesText(item.shares),
                  })
                : outcomeText(t, item.kind))}
          </p>
          {bought ? (
            <>
              <div className="document-totals">
                {(
                  [
                    [
                      interest ? t('receipt.interest_used') : t('receipt.contributed'),
                      moneyFine(source),
                      'USDT',
                    ],
                    [t('receipt.spent'), money(item.spendUsd), 'USDT'],
                    [t('receipt.shares'), sharesText(item.shares), ticker],
                  ] as const
                ).map(([label, value, unit]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>
                      {value ?? '—'} <small>{unit}</small>
                    </strong>
                  </div>
                ))}
              </div>
              <MoneyFlow
                compact
                title={t('receipt.flow.aria', {
                  source: moneyFine(source) ?? '—',
                  ticker,
                })}
                unit="USDT"
                ticker={ticker}
                source={{
                  text: moneyFine(source),
                  label: interest ? t('flow.earned') : t('receipt.source.contribution'),
                  flows: true,
                }}
                destination={{
                  text: money(item.spendUsd),
                  label: t('flow.reinvested', { ticker }),
                  flows: true,
                }}
              />
            </>
          ) : null}
          <Ledger
            rows={[
              [t('receipt.plan'), item.plan ? planName(t, item.plan) : '—'],
              ...(bought || item.kind === 'SIMULATED'
                ? ([
                    [
                      t('receipt.source'),
                      interest ? t('receipt.source.interest') : t('receipt.source.contribution'),
                    ],
                    [t('receipt.asset'), t('receipt.asset.value', { ticker })],
                  ] as [string, string][])
                : []),
              ...(item.instrumentId
                ? ([[t('judge.details.issuer'), issuerName(item.instrumentId) ?? '—']] as [
                    string,
                    string,
                  ][])
                : []),
              [t('receipt.chain'), 'BNB Smart Chain'],
              [t('receipt.mode'), simulated ? t('trace.mode.simulate') : t('trace.mode.live')],
            ]}
          />
          <ReceiptLinks t={t} item={item} />
          <div className={`receipt-disclaimer ${item.receipts.length > 0 ? 'live' : ''}`}>
            <Icon name="info" />
            <span>
              {simulated
                ? t('judge.done.simulated')
                : item.receipts.length > 0
                  ? t('receipt.disclaimer.onchain')
                  : t('receipt.disclaimer.none')}
            </span>
          </div>
          <div className="button-row document-links">
            <Link className="text-button document-back" href="/activity">
              <Icon name="back" size={18} />
              {t('receipt.back')}
            </Link>
            {item.plan ? (
              <Link className="text-button document-back" href={`/plans/${item.plan.id}`}>
                {t('judge.plan.link')}
              </Link>
            ) : null}
          </div>
        </section>
        <Trace
          t={t}
          lang={lang}
          tz={tz}
          steps={steps}
          failed={item.kind === 'FAILED'}
          finished={finishedAt !== null}
          caption={
            finishedAt
              ? t('trace.caption', {
                  start: timeText(item.at, lang, tz),
                  end: timeText(finishedAt, lang, tz),
                })
              : t('trace.caption.open', { start: timeText(item.at, lang, tz) })
          }
        />
      </div>
    </>
  );
}
