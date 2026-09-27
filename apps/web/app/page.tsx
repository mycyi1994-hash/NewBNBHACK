/**
 * Overview (the approved design's first tab; M2-01): Yieldvest's own interest plan as it stands —
 * principal in Venus, interest available now, the next buy — and where its interest has gone:
 * earned → reinvested into the stock, the rest carried forward. Beside it, the latest real receipt.
 * Every value is read from the database or the chain; what cannot be read says why (rule 4).
 */
import type { Metadata } from 'next';
import { EmptyReceiptPanel, ReceiptPanel } from '../components/activity/items';
import { AutoRefresh, MoneyFlow, ProgressStrip } from '../components/design';
import { Icon } from '../components/Icon';
import { AnimatedText } from '../components/motion';
import { pausedText, planName, statusText } from '../components/plan-text';
import { Toolbar } from '../components/Toolbar';
import { SectionHeading, Status, SummaryStrip, Unavailable, type Tone } from '../components/ui';
import { grouped, money, moneyFine, timeText } from '../lib/format';
import { locale } from '../lib/i18n/server';
import type { Lang, T } from '../lib/i18n/translate';
import { activityFeed, type ActivityItem } from '../lib/server/activity';
import { context } from '../lib/server/context';
import { houseStory, type HouseStory } from '../lib/server/overview';
import { settle, type Settled } from '../lib/server/settle';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: { absolute: `Yieldvest — ${t('brand.tagline')}` } };
}

const noDatabase = { ok: false, reason: 'no database' } as const;

export default async function OverviewPage() {
  const { lang, tz, t } = await locale();
  const { config, db } = context();
  const now = new Date();
  const [house, feed]: [Settled<HouseStory>, Settled<ActivityItem[]>] = db
    ? await Promise.all([
        settle('database', () => houseStory(db, config, now)),
        settle('database', () => activityFeed(db, 40)),
      ])
    : [noDatabase, noDatabase];
  const latest = feed.ok ? latestBuy(feed.value) : null;

  return (
    <>
      <AutoRefresh />
      <Toolbar t={t} lang={lang} tz={tz} title={t('nav.overview')} />
      <Summary t={t} lang={lang} tz={tz} house={house} />
      <div className="workspace-grid">
        <section className="visual-workspace">
          <Flow t={t} lang={lang} tz={tz} house={house} />
        </section>
        {latest ? (
          <ReceiptPanel t={t} lang={lang} tz={tz} item={latest} eyebrow={t('receipt.latest')} />
        ) : (
          <EmptyReceiptPanel t={t} eyebrow={t('receipt.latest')} />
        )}
      </div>
      <NextBuy t={t} house={house} />
    </>
  );
}

/** The newest buy, preferring one paid with interest (the product's point). */
function latestBuy(items: ActivityItem[]): ActivityItem | null {
  const buys = items.filter((i) => i.kind === 'BOUGHT');
  return buys.find((i) => i.interestUsd !== null) ?? buys[0] ?? null;
}

function planStatus(t: T, house: HouseStory): { tone: Tone; text: string } {
  const plan = house.plan;
  if (!plan)
    return { tone: 'skip', text: t('home.status.unavailable', { reason: 'no yield plan' }) };
  if (plan.status === 'paused') {
    return { tone: 'wait', text: pausedText(t, plan.pausedReason) ?? statusText(t, 'paused') };
  }
  if (plan.status !== 'active') return { tone: 'skip', text: statusText(t, plan.status) };
  return house.leftUsd !== null && Number(house.leftUsd) === 0
    ? { tone: 'ok', text: t('overview.status.ready') }
    : { tone: 'ok', text: t('overview.status.waiting') };
}

function Summary({
  t,
  lang,
  tz,
  house,
}: {
  t: T;
  lang: Lang;
  tz: string;
  house: Settled<HouseStory>;
}) {
  if (!house.ok) {
    return (
      <SummaryStrip
        label={t('overview.summary')}
        items={[
          { label: t('overview.supplied'), value: '—' },
          { label: t('overview.available'), value: '—' },
          { label: t('overview.next'), value: '—' },
        ]}
        status={
          <Status tone="skip">{t('home.status.unavailable', { reason: house.reason })}</Status>
        }
      />
    );
  }
  const { plan, interest } = house.value;
  const status = planStatus(t, house.value);
  const available = moneyFine(interest.availableUsd);
  return (
    <SummaryStrip
      label={t('overview.summary')}
      items={[
        {
          label: t('overview.supplied'),
          value: plan ? (
            <>
              {grouped(money(plan.principalUsd))} <small>USDT</small>
            </>
          ) : (
            '—'
          ),
        },
        {
          label: t('overview.available'),
          value: available ? (
            <>
              <AnimatedText value={available} /> <small>USDT</small>
            </>
          ) : (
            '—'
          ),
          note:
            interest.state === 'LIVE'
              ? interest.asOf
                ? t('home.counter.asof', { time: timeText(interest.asOf, lang, tz) })
                : undefined
              : t('home.status.unavailable', { reason: interest.reason ?? '' }),
        },
        {
          label: t('overview.next'),
          value: (
            <>
              {money(house.value.minBuyUsd)} <small>USDT</small>
            </>
          ),
          note:
            plan?.status === 'active'
              ? t('overview.next.note', { time: timeText(plan.nextDueAt, lang, tz) })
              : undefined,
        },
      ]}
      status={<Status tone={status.tone}>{status.text}</Status>}
    />
  );
}

function Flow({
  t,
  lang,
  tz,
  house,
}: {
  t: T;
  lang: Lang;
  tz: string;
  house: Settled<HouseStory>;
}) {
  if (!house.ok || !house.value.plan) {
    return (
      <>
        <SectionHeading title={t('overview.flow.title')} />
        <div className="visual-footnote">
          <Unavailable t={t} reason={house.ok ? 'no yield plan' : house.reason} />
        </div>
      </>
    );
  }
  const { plan, story, interest } = house.value;
  const ticker = plan.ticker ?? '';
  const spent = story?.spentUsd ?? '0';
  const reinvested = Number(spent) > 0;
  const carried = interest.availableUsd !== null && Number(interest.availableUsd) > 0;
  const earned = house.value.earnedUsd;
  const sub = [
    planName(t, plan),
    story?.since ? t('overview.flow.since', { date: timeText(story.since, lang, tz) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const note =
    interest.state !== 'LIVE' ? (
      <Unavailable t={t} reason={interest.reason ?? ''} />
    ) : (
      <>
        <Icon name="info" size={16} />
        <span>
          {reinvested
            ? t('overview.flow.note')
            : t('overview.flow.first', { min: money(house.value.minBuyUsd) })}
        </span>
      </>
    );
  return (
    <>
      <SectionHeading title={t('overview.flow.title')} sub={sub} />
      <MoneyFlow
        title={t('overview.flow.aria', {
          earned: moneyFine(earned) ?? '—',
          spent: moneyFine(spent) ?? '—',
          ticker,
          carried: moneyFine(interest.availableUsd) ?? '—',
        })}
        unit="USDT"
        ticker={ticker}
        source={{
          text: moneyFine(earned),
          label: t('flow.earned'),
          flows: reinvested || carried,
        }}
        destination={{
          text: moneyFine(spent),
          label: t('flow.reinvested', { ticker }),
          flows: reinvested,
        }}
        remainder={{
          text: moneyFine(interest.availableUsd),
          label: t('flow.carried'),
          flows: carried,
        }}
        href={story?.lastBuyCycleId ? `/activity/${story.lastBuyCycleId}` : `/plans/${plan.id}`}
      />
      <div className="visual-footnote">{note}</div>
    </>
  );
}

function NextBuy({ t, house }: { t: T; house: Settled<HouseStory> }) {
  if (!house.ok || !house.value.plan) return null;
  const { plan, interest, leftUsd, percent, minBuyUsd } = house.value;
  const available = moneyFine(interest.availableUsd);
  return (
    <ProgressStrip
      label={t('progress.next', { ticker: plan.ticker ?? '' })}
      amount={
        available
          ? t('progress.amount', { available, min: money(minBuyUsd) })
          : t('home.status.unavailable', { reason: interest.reason ?? '' })
      }
      percent={percent}
      action={
        leftUsd === null
          ? t('common.details')
          : Number(leftUsd) === 0
            ? t('progress.ready')
            : t('progress.left', { left: moneyFine(leftUsd) })
      }
      href="/earn"
      aria={t('progress.aria')}
    />
  );
}
