/**
 * Activity (the approved design's fourth tab): every step, accounted for. Yieldvest's own plans
 * show each cycle — bought, waiting, skipped, failed — with its one-line reason; every on-chain
 * receipt is here with its BscScan link. Totals are counted over everything recorded.
 */
import type { Metadata } from 'next';
import { ActivityBoard, type BoardItem } from '../../components/activity/ActivityBoard';
import { EmptyReceiptPanel, EventRow, ReceiptPanel } from '../../components/activity/items';
import { Toolbar } from '../../components/Toolbar';
import { SectionHeading, Status, SummaryStrip, Unavailable } from '../../components/ui';
import { grouped, money, timeText } from '../../lib/format';
import { locale } from '../../lib/i18n/server';
import { activityFeed, activityTotals } from '../../lib/server/activity';
import { context } from '../../lib/server/context';
import { settle } from '../../lib/server/settle';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: t('nav.activity') };
}

const noDatabase = { ok: false, reason: 'no database' } as const;

export default async function ActivityPage() {
  const { lang, tz, t } = await locale();
  const { db } = context();
  const [feed, totals] = db
    ? await Promise.all([
        settle('database', () => activityFeed(db, 60)),
        settle('database', () => activityTotals(db)),
      ])
    : [noDatabase, noDatabase];
  const heading = <SectionHeading title={t('activity.title')} sub={t('activity.sub')} />;
  const items: BoardItem[] = feed.ok
    ? feed.value.map((item) => ({
        key: item.key,
        group: item.kind,
        row: <EventRow t={t} lang={lang} tz={tz} item={item} />,
        panel: (
          <ReceiptPanel t={t} lang={lang} tz={tz} item={item} eyebrow={t('receipt.eyebrow')} />
        ),
      }))
    : [];
  return (
    <>
      <Toolbar t={t} lang={lang} tz={tz} title={t('nav.activity')} />
      <SummaryStrip
        label={t('activity.summary')}
        items={
          totals.ok
            ? [
                { label: t('activity.stat.purchases'), value: String(totals.value.purchases) },
                {
                  label: t('activity.stat.bought'),
                  value: (
                    <>
                      {grouped(money(totals.value.boughtUsd))} <small>USDT</small>
                    </>
                  ),
                },
                { label: t('activity.stat.receipts'), value: String(totals.value.receipts) },
              ]
            : [
                { label: t('activity.stat.purchases'), value: '—' },
                { label: t('activity.stat.bought'), value: '—' },
                { label: t('activity.stat.receipts'), value: '—' },
              ]
        }
        status={
          totals.ok ? (
            totals.value.lastPurchaseAt ? (
              <Status tone="ok">
                {t('activity.stat.last', { time: timeText(totals.value.lastPurchaseAt, lang, tz) })}
              </Status>
            ) : (
              <Status tone="neutral">{t('home.feed.empty')}</Status>
            )
          ) : (
            <Status tone="skip">{t('home.status.unavailable', { reason: totals.reason })}</Status>
          )
        }
      />
      {feed.ok ? (
        <ActivityBoard
          lang={lang}
          heading={heading}
          items={items}
          listLabel={t('activity.list')}
          empty={<EmptyReceiptPanel t={t} eyebrow={t('receipt.eyebrow')} />}
        />
      ) : (
        <div className="workspace-grid">
          <section className="visual-workspace">
            {heading}
            <div className="visual-footnote">
              <Unavailable t={t} reason={feed.reason} />
            </div>
          </section>
          <EmptyReceiptPanel t={t} eyebrow={t('receipt.eyebrow')} />
        </div>
      )}
    </>
  );
}
