/**
 * Earn (the approved design's second tab): the interest account behind the house interest plan —
 * Venus USDT, today's rate and security score as the worker recorded them, principal, the interest
 * that accrued in this cycle and what was carried forward, against the minimum buy. The chart joins
 * two readings (cycle start, now); nothing in between is drawn as if it had been read.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh, InterestChart, ProgressStrip } from '../../components/design';
import { InterestCalculator, type CalculatorStock } from '../../components/earn/InterestCalculator';
import { Icon } from '../../components/Icon';
import { AnimatedText } from '../../components/motion';
import { pausedText, statusText } from '../../components/plan-text';
import { Toolbar } from '../../components/Toolbar';
import {
  BlockTitle,
  Ledger,
  Panel,
  SectionHeading,
  StateBadge,
  Status,
  SummaryStrip,
  Unavailable,
} from '../../components/ui';
import { grouped, minutesSince, money, moneyFine, timeText } from '../../lib/format';
import { locale } from '../../lib/i18n/server';
import type { Lang, T } from '../../lib/i18n/translate';
import { context } from '../../lib/server/context';
import { venusInfo, type VenusInfo } from '../../lib/server/house';
import { marketStatus, type MarketStatus } from '../../lib/server/market';
import { houseStory, type HouseStory } from '../../lib/server/overview';
import { startingDeposit } from '../../lib/projection';
import { apyView } from '../../lib/server/projection';
import { settle, type Settled } from '../../lib/server/settle';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: t('nav.earn') };
}

const noDatabase = { ok: false, reason: 'no database' } as const;

export default async function EarnPage() {
  const { lang, tz, t } = await locale();
  const { config, db } = context();
  const now = new Date();
  const [house, venus, market]: [Settled<HouseStory>, Settled<VenusInfo>, Settled<MarketStatus>] =
    db
      ? await Promise.all([
          settle('database', () => houseStory(db, config, now)),
          settle('database', () => venusInfo(db, now)),
          settle('database', () => marketStatus(db, now)),
        ])
      : [noDatabase, noDatabase, noDatabase];
  const plan = house.ok ? house.value.plan : null;
  const interest = house.ok ? house.value.interest : null;
  const available = moneyFine(interest?.availableUsd ?? null);
  const status =
    !house.ok || !plan
      ? {
          tone: 'skip' as const,
          text: t('home.status.unavailable', { reason: house.ok ? 'no yield plan' : house.reason }),
        }
      : plan.status === 'paused'
        ? {
            tone: 'wait' as const,
            text: pausedText(t, plan.pausedReason) ?? statusText(t, 'paused'),
          }
        : plan.status === 'active'
          ? { tone: 'ok' as const, text: t('earn.status') }
          : { tone: 'skip' as const, text: statusText(t, plan.status) };

  return (
    <>
      <AutoRefresh />
      <Toolbar t={t} lang={lang} tz={tz} title={t('nav.earn')} />
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
              interest && interest.state !== 'LIVE'
                ? t('home.status.unavailable', { reason: interest.reason ?? '' })
                : undefined,
          },
          {
            label: t('earn.threshold'),
            value: house.ok ? (
              <>
                {money(house.value.minBuyUsd)} <small>USDT</small>
              </>
            ) : (
              '—'
            ),
          },
        ]}
        status={<Status tone={status.tone}>{status.text}</Status>}
      />
      <div className="workspace-grid">
        <section className="visual-workspace">
          <Chart t={t} lang={lang} tz={tz} house={house} />
        </section>
        <Details t={t} now={now} house={house} venus={venus} />
      </div>
      {house.ok && plan ? (
        <ProgressStrip
          label={t('progress.next', { ticker: plan.ticker ?? '' })}
          amount={
            available
              ? t('progress.amount', { available, min: money(house.value.minBuyUsd) })
              : t('home.status.unavailable', { reason: interest?.reason ?? '' })
          }
          percent={house.value.percent}
          action={t('earn.cta.activity')}
          href={`/plans/${plan.id}`}
          aria={t('progress.aria')}
        />
      ) : null}
      <Calculator
        t={t}
        lang={lang}
        tz={tz}
        now={now}
        venus={venus}
        market={market}
        minBuyUsd={String(config.caps.minBuyUsd)}
        depositUsd={startingDeposit(plan?.principalUsd)}
      />
    </>
  );
}

/**
 * One share price per ticker for the calculator: bStocks first, then Ondo, from a LIVE tape only —
 * "at today's price" is never an old price.
 */
function calculatorStocks(market: Settled<MarketStatus>): CalculatorStock[] {
  if (!market.ok || market.value.data.state !== 'LIVE') return [];
  const out = new Map<string, CalculatorStock>();
  const order = ['bstocks', 'ondo'];
  const priced = market.value.instruments
    .filter((i) => i.onchainSharePriceUsd !== null)
    .sort((a, b) => order.indexOf(a.issuer) - order.indexOf(b.issuer));
  for (const i of priced) {
    if (!out.has(i.ticker) && i.onchainSharePriceUsd) {
      out.set(i.ticker, {
        ticker: i.ticker,
        sharePriceUsd: i.onchainSharePriceUsd,
        venueMinUsd: i.venueMinUsd,
      });
    }
  }
  return [...out.values()];
}

function Calculator({
  t,
  lang,
  tz,
  now,
  venus,
  market,
  minBuyUsd,
  depositUsd,
}: {
  t: T;
  lang: Lang;
  tz: string;
  now: Date;
  venus: Settled<VenusInfo>;
  market: Settled<MarketStatus>;
  minBuyUsd: string;
  depositUsd: string;
}) {
  const apy = venus.ok ? apyView(venus.value, now) : null;
  // A rate is LIVE, STALE with the time it was read, or not shown: a stale rate without a read
  // time cannot say how old it is.
  const data =
    !venus.ok || !apy || apy.state === 'UNAVAILABLE'
      ? { state: 'UNAVAILABLE' as const, reason: venus.ok ? 'no rate recorded yet' : venus.reason }
      : apy.state === 'LIVE'
        ? { state: 'LIVE' as const }
        : apy.at
          ? { state: 'STALE' as const, at: apy.at }
          : { state: 'UNAVAILABLE' as const, reason: 'rate read time unknown' };
  return (
    <section className="page-block" aria-label={t('calc.title')}>
      <BlockTitle aside={<StateBadge t={t} data={data} now={now} />}>{t('calc.title')}</BlockTitle>
      {apy?.pct && data.state !== 'UNAVAILABLE' ? (
        <InterestCalculator
          lang={lang}
          tz={tz}
          apy={{ pct: apy.pct, at: apy.at, stale: data.state === 'STALE' }}
          minBuyUsd={minBuyUsd}
          stocks={calculatorStocks(market)}
          initialDepositUsd={depositUsd}
        />
      ) : (
        <p className="state-line">{t('calc.unavailable')}</p>
      )}
    </section>
  );
}

function Chart({
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
  const story = house.ok ? house.value.story : null;
  const sub = story?.cycleStart
    ? t('earn.since', { time: timeText(story.cycleStart, lang, tz) })
    : undefined;
  if (!house.ok || !house.value.plan || house.value.interest.state !== 'LIVE') {
    const reason = !house.ok
      ? house.reason
      : !house.value.plan
        ? 'no yield plan'
        : (house.value.interest.reason ?? '');
    return (
      <>
        <SectionHeading title={t('earn.title')} sub={sub} />
        <div className="visual-footnote">
          <Unavailable t={t} reason={reason} />
        </div>
      </>
    );
  }
  const { interest, minBuyUsd } = house.value;
  const carried = moneyFine(interest.carriedUsd) ?? '0.00';
  const fresh = moneyFine(interest.inPositionUsd) ?? '0.00';
  const available = moneyFine(interest.availableUsd) ?? '0.00';
  return (
    <>
      <SectionHeading title={t('earn.title')} sub={sub} />
      <InterestChart
        title={t('earn.chart.aria', { carried, available, min: money(minBuyUsd) })}
        carried={Number(interest.carriedUsd)}
        available={Number(interest.availableUsd)}
        min={Number(minBuyUsd)}
        labels={{
          start: t('earn.chart.start'),
          now: t('earn.chart.now'),
          threshold: t('earn.chart.threshold', { min: money(minBuyUsd) }),
          value: `${available} USDT`,
          carried: t('earn.legend.carried', { value: carried }),
          fresh: t('earn.legend.new', { value: fresh }),
        }}
      />
    </>
  );
}

function rateText(t: T, now: Date, venus: Settled<VenusInfo>): string {
  if (!venus.ok || !venus.value.apy) return '—';
  const at = venus.value.apyAt;
  if (venus.value.fresh || !at) return `${venus.value.apy}%`;
  return `${venus.value.apy}% · ${t('home.status.stale', { min: minutesSince(at, now) })}`;
}

function Details({
  t,
  now,
  house,
  venus,
}: {
  t: T;
  now: Date;
  house: Settled<HouseStory>;
  venus: Settled<VenusInfo>;
}) {
  if (!house.ok || !house.value.plan) {
    return (
      <Panel eyebrow={t('earn.panel.eyebrow')} title={t('earn.panel.unavailable')} waiting>
        <p className="panel-note">
          {t('home.status.unavailable', { reason: house.ok ? 'no yield plan' : house.reason })}
        </p>
      </Panel>
    );
  }
  const { plan, interest, leftUsd, minBuyUsd } = house.value;
  const reached = leftUsd !== null && Number(leftUsd) === 0;
  const score = venus.ok ? venus.value.securityScore : null;
  return (
    <Panel
      eyebrow={t('earn.panel.eyebrow')}
      title={reached ? t('earn.panel.ready') : t('earn.panel.waiting', { min: money(minBuyUsd) })}
      waiting={!reached}
    >
      <Ledger
        rows={[
          [t('earn.protocol'), 'Venus'],
          [t('earn.asset'), 'USDT'],
          [t('earn.apy'), rateText(t, now, venus)],
          [t('earn.score'), score ?? '—'],
          [t('home.house.principal'), `${grouped(money(plan.principalUsd))} USDT`],
          [
            t('earn.new'),
            interest.inPositionUsd === null ? '—' : `${moneyFine(interest.inPositionUsd)} USDT`,
          ],
          [t('flow.carried'), `${moneyFine(interest.carriedUsd)} USDT`],
        ]}
      />
      <div className="panel-total">
        <span>{t('earn.available')}</span>
        <strong>
          {interest.availableUsd === null ? '—' : `${moneyFine(interest.availableUsd)} USDT`}
        </strong>
      </div>
      <p className="panel-note">
        {leftUsd === null
          ? t('home.status.unavailable', { reason: interest.reason ?? '' })
          : reached
            ? t('earn.note.ready')
            : t('earn.note.left', { left: moneyFine(leftUsd) })}
      </p>
      <Link className="button dark wide" href={`/plans/${plan.id}`}>
        {t('earn.cta.activity')}
        <Icon name="arrow" size={18} />
      </Link>
      <p className="panel-caption">
        <Link href="/risk">{t('footer.risk')}</Link>
      </p>
    </Panel>
  );
}
