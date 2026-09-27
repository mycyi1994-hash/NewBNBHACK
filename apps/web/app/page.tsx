/**
 * Watch (M2-01, DESIGN_BRIEF §5.1): what it is, proof that it runs (the house plans and their
 * receipts), and the two ways to try it. Every block states its data: live, stale with its time,
 * or unavailable with the reason — nothing here is a placeholder number.
 */
import { latestGuardianSamples, openGuardianActions } from '@yieldvest/db';
import Link from 'next/link';
import { InterestCounter } from '../components/home/InterestCounter';
import { planName, pausedText, ruleName, statusText } from '../components/plan-text';
import {
  buttonClass,
  Card,
  OutcomeBadge,
  Pill,
  ReceiptLink,
  SectionTitle,
  Stat,
  StateBadge,
  tapeState,
  whyText,
} from '../components/ui';
import { money, sharesText, signedPct, timeText } from '../lib/format';
import { locale } from '../lib/i18n/server';
import type { Lang, T } from '../lib/i18n/translate';
import { context } from '../lib/server/context';
import { dxTape, sessionGapSummary } from '../lib/server/dx';
import { houseView, venusInfo, type HousePlan, type VenusInfo } from '../lib/server/house';
import { marketStatus, type MarketStatus } from '../lib/server/market';
import { receiptFeed, type FeedItem } from '../lib/server/receipts';
import { settle, type Settled } from '../lib/server/settle';

export const dynamic = 'force-dynamic';

const unavailable = { ok: false, reason: 'no database' } as const;

export default async function WatchPage() {
  const { lang, tz, t } = await locale();
  const { config, db } = context();
  const now = new Date();
  const [house, feed, market, tape, venus] = db
    ? await Promise.all([
        settle('database', () => houseView(db, config, now)),
        settle('database', () => receiptFeed(db, 30)),
        settle('database', () => marketStatus(db, now)),
        settle('database', () => dxTape(db, 7, now)),
        settle('database', () => venusInfo(db)),
      ])
    : [unavailable, unavailable, unavailable, unavailable, unavailable];
  const plans = house.ok ? house.value.plans : [];
  const yieldPlan = plans.find((p) => p.mode === 'yield');
  const minBuyUsd = String(config.caps.minBuyUsd);

  return (
    <div className="flex flex-col gap-10">
      <section className="grid items-center gap-6 md:grid-cols-[1.1fr_1fr]">
        <div>
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight md:text-5xl">
            {t('home.title')}
          </h1>
          <p className="mt-4 text-lg text-muted">{t('home.sub')}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link href="/judge" className={buttonClass.primary}>
              {t('home.cta.judge')}
            </Link>
            <Link href="/skill" className={buttonClass.secondary}>
              {t('home.cta.skill')}
            </Link>
          </div>
        </div>
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-muted">{t('home.house.interest')}</span>
            {yieldPlan?.interest.state === 'LIVE' ? (
              <StateBadge t={t} data={{ state: 'LIVE' }} now={now} />
            ) : null}
          </div>
          {yieldPlan ? (
            <InterestCounter
              lang={lang}
              tz={tz}
              planId={yieldPlan.id}
              initial={yieldPlan.interest}
              minBuyUsd={minBuyUsd}
            />
          ) : (
            <StateBadge
              t={t}
              data={{ state: 'UNAVAILABLE', reason: house.ok ? 'no yield plan' : house.reason }}
              now={now}
            />
          )}
          <VenusLine t={t} venus={venus} />
          {yieldPlan ? (
            <Link
              href={`/plans/${yieldPlan.id}`}
              className="mt-3 inline-block text-sm font-medium text-brand hover:underline"
            >
              {t('home.house.link')}
            </Link>
          ) : null}
        </Card>
      </section>

      <section>
        <SectionTitle>{t('home.house.card.title')}</SectionTitle>
        {house.ok ? (
          <div className="grid gap-4 md:grid-cols-2">
            {plans.map((plan) => (
              <HouseCard
                key={plan.id}
                t={t}
                lang={lang}
                tz={tz}
                plan={plan}
                minBuyUsd={minBuyUsd}
              />
            ))}
          </div>
        ) : (
          <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: house.reason }} now={now} />
        )}
      </section>

      <section>
        <SectionTitle>{t('home.feed.title')}</SectionTitle>
        <Feed t={t} lang={lang} tz={tz} feed={feed} now={now} />
      </section>

      <Insight t={t} tape={tape} now={now} />

      <section>
        <SectionTitle
          aside={
            market.ok ? (
              <StateBadge t={t} data={tapeState(market.value.data, 'no tape yet')} now={now} />
            ) : null
          }
        >
          {t('home.stocks.title')}
        </SectionTitle>
        <Stocks t={t} market={market} now={now} />
      </section>

      <section>
        <SectionTitle>{t('home.trust.title')}</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            t('home.trust.simulate'),
            t('home.trust.caps', {
              perTx: money(String(config.caps.houseMaxPerTxUsd)),
              daily: money(String(config.caps.dailySpendCapUsd)),
            }),
            t('home.trust.keys'),
          ].map((line) => (
            <Card key={line} className="!p-4">
              <p className="text-sm font-medium text-ink">
                <span aria-hidden="true" className="mr-1.5 text-brand">
                  ✓
                </span>
                {line}
              </p>
            </Card>
          ))}
          <Card className="!p-4">
            <p className="text-sm font-semibold text-muted">{t('plan.guardian.title')}</p>
            <div className="mt-1 text-sm font-medium text-ink">
              <GuardianLine t={t} />
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}

async function GuardianLine({ t }: { t: T }) {
  const { db } = context();
  const { lang, tz } = await locale();
  if (!db) return <>{t('plan.guardian.nodata')}</>;
  const samples = await settle('database', async () => ({
    latest: await latestGuardianSamples(db),
    open: await openGuardianActions(db),
  }));
  if (!samples.ok) return <>{t('plan.guardian.nodata')}</>;
  const open = samples.value.open.filter((a) => a.action !== 'warn');
  if (open.length > 0) {
    return (
      <>{t('plan.guardian.open', { rule: open.map((a) => ruleName(t, a.rule)).join(', ') })}</>
    );
  }
  const times = Object.values(samples.value.latest).map((s) => s.ts);
  const last = times.sort().at(-1);
  return (
    <>
      {last ? t('plan.guardian.ok', { time: timeText(last, lang, tz) }) : t('plan.guardian.nodata')}
    </>
  );
}

function VenusLine({ t, venus }: { t: T; venus: Settled<VenusInfo> | typeof unavailable }) {
  if (!venus.ok || !venus.value.fresh) return null;
  const apy = venus.value.apy;
  const score = venus.value.securityScore;
  if (!apy || !score) return null;
  return <p className="mt-3 text-xs text-muted">{t('home.counter.apy', { apy, score })}</p>;
}

function sharesOf(plan: HousePlan): string | null {
  const total = plan.holdings.reduce((sum, h) => sum + Number(h.shares), 0);
  return plan.holdings.length > 0 ? sharesText(total.toFixed(18)) : '0';
}

function HouseCard({
  t,
  lang,
  tz,
  plan,
  minBuyUsd,
}: {
  t: T;
  lang: Lang;
  tz: string;
  plan: HousePlan;
  minBuyUsd: string;
}) {
  const paused = pausedText(t, plan.pausedReason);
  const next =
    plan.status === 'active'
      ? plan.mode === 'yield'
        ? t('home.house.next.min', { min: money(minBuyUsd) })
        : timeText(plan.nextDueAt, lang, tz)
      : (paused ?? t('plan.next.none'));
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-base font-bold">{planName(t, plan)}</h3>
        <Pill tone={plan.status === 'active' ? 'ok' : plan.status === 'paused' ? 'wait' : 'skip'}>
          {statusText(t, plan.status)}
        </Pill>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        {plan.mode === 'yield' ? (
          <>
            <Stat label={t('home.house.principal')} value={`$${money(plan.principalUsd)}`} />
            <Stat
              label={t('home.house.interest')}
              value={plan.interest.usd !== null ? `$${money(plan.interest.usd)}` : '—'}
              sub={
                plan.interest.state === 'UNAVAILABLE'
                  ? t('home.status.unavailable', { reason: plan.interest.reason ?? '' })
                  : undefined
              }
            />
          </>
        ) : null}
        <Stat label={t('home.house.shares')} value={`${sharesOf(plan) ?? '0'}`} />
        <Stat label={t('home.house.next')} value={<span className="text-base">{next}</span>} />
      </div>
      <p className="num mt-4 text-sm text-muted">
        {t('home.house.today', {
          used: money(plan.limits.usedTodayUsd),
          daily: money(plan.limits.perDayUsd),
        })}
      </p>
      {plan.last ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <OutcomeBadge t={t} kind={plan.last.outcome} />
          <span className="text-muted">{whyText(t, lang, tz, plan.last.why)}</span>
        </div>
      ) : null}
      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-muted">{t('home.house.receipts', { n: plan.receiptCount })}</span>
        <Link href={`/plans/${plan.id}`} className="font-medium text-brand hover:underline">
          {t('home.house.link')}
        </Link>
      </div>
    </Card>
  );
}

function Feed({
  t,
  lang,
  tz,
  feed,
  now,
}: {
  t: T;
  lang: Lang;
  tz: string;
  feed: Settled<FeedItem[]> | typeof unavailable;
  now: Date;
}) {
  if (!feed.ok) {
    return <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: feed.reason }} now={now} />;
  }
  const items = feed.value.filter((r) => r.kind !== 'approve').slice(0, 10);
  if (items.length === 0) return <p className="text-muted">{t('home.feed.empty')}</p>;
  return (
    <Card className="!p-0">
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <li
            key={item.txHash}
            className="flex flex-col gap-1.5 p-4 md:flex-row md:items-center md:gap-4"
          >
            <span className="num w-36 shrink-0 text-sm text-muted">
              {timeText(item.at, lang, tz)}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="font-semibold">{item.ticker}</span>
              {item.kind === 'deposit' ? (
                <Pill tone="info">{t('outcome.deposit')}</Pill>
              ) : item.kind === 'redeem' ? (
                <Pill tone="info">{t('outcome.redeem')}</Pill>
              ) : (
                <OutcomeBadge t={t} kind={item.outcome} />
              )}
              {item.mode === 'yield' && item.kind === 'swap' ? (
                <Pill tone="neutral" icon={false}>
                  {t('outcome.interest_only')}
                </Pill>
              ) : null}
            </span>
            <span className="min-w-0 flex-1 text-sm text-ink">
              {whyText(t, lang, tz, item.why)}
            </span>
            <Link href={`/plans/${item.planId}`} className="text-sm text-muted hover:text-ink">
              {t('home.house.link')}
            </Link>
            <ReceiptLink t={t} href={item.explorerUrl} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Insight({
  t,
  tape,
  now,
}: {
  t: T;
  tape: Settled<Awaited<ReturnType<typeof dxTape>>> | typeof unavailable;
  now: Date;
}) {
  const summary = tape.ok ? sessionGapSummary(tape.value.rows) : null;
  const regular = signedPct(summary?.regular ?? null);
  const offhours = signedPct(summary?.offHours ?? null);
  return (
    <Card>
      <SectionTitle
        aside={
          tape.ok ? (
            regular && offhours ? (
              <StateBadge t={t} data={{ state: 'LIVE' }} now={now} />
            ) : (
              <StateBadge
                t={t}
                data={{ state: 'UNAVAILABLE', reason: 'not enough samples with a US price' }}
                now={now}
              />
            )
          ) : (
            <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: tape.reason }} now={now} />
          )
        }
      >
        {t('home.insight.title')}
      </SectionTitle>
      {regular && offhours ? (
        <p className="num text-base text-ink">{t('home.insight.summary', { offhours, regular })}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span>{t('home.insight.source')}</span>
        <Link href="/dx" className="font-medium text-brand hover:underline">
          {t('home.insight.more')}
        </Link>
      </div>
    </Card>
  );
}

function Stocks({
  t,
  market,
  now,
}: {
  t: T;
  market: Settled<MarketStatus> | typeof unavailable;
  now: Date;
}) {
  if (!market.ok) {
    return <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: market.reason }} now={now} />;
  }
  const byTicker = new Map<string, MarketStatus['instruments']>();
  for (const instrument of market.value.instruments) {
    byTicker.set(instrument.ticker, [...(byTicker.get(instrument.ticker) ?? []), instrument]);
  }
  if (byTicker.size === 0) {
    return <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: 'registry empty' }} now={now} />;
  }
  const multiplier = market.value.instruments.find((i) => i.issuer === 'bstocks')?.multiplier;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[...byTicker.entries()].map(([ticker, venues]) => {
          const bstocks = venues.find((v) => v.issuer === 'bstocks');
          const ondo = venues.find((v) => v.issuer === 'ondo');
          const price =
            venues.find((v) => v.stockPriceUsd)?.stockPriceUsd ??
            venues.find((v) => v.onchainSharePriceUsd)?.onchainSharePriceUsd ??
            null;
          return (
            <Card key={ticker} className="!p-4">
              <div className="text-lg font-bold">{ticker}</div>
              <div className="num mt-1 text-sm text-muted">
                {t('home.stocks.price')} {price ? `$${money(price)}` : '—'}
              </div>
              <div className="mt-3 text-xs text-muted">{t('home.stocks.where')}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {bstocks ? (
                  <Pill tone="neutral" icon={false}>
                    bStocks
                  </Pill>
                ) : null}
                {ondo ? (
                  <Pill tone="neutral" icon={false}>
                    Ondo
                  </Pill>
                ) : null}
              </div>
              {!bstocks && ondo?.venueMinUsd ? (
                <p className="mt-2 text-xs text-wait">
                  {t('home.stocks.only_ondo', { min: ondo.venueMinUsd })}
                </p>
              ) : ondo?.venueMinUsd ? (
                <p className="mt-2 text-xs text-muted">
                  Ondo · {t('home.stocks.min', { min: ondo.venueMinUsd })}
                </p>
              ) : null}
            </Card>
          );
        })}
      </div>
      {multiplier ? (
        <p className="mt-3 text-sm text-muted">
          {t('home.stocks.multiplier', { m: Number(multiplier).toFixed(4) })}
        </p>
      ) : null}
    </>
  );
}
