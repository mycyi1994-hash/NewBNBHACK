/**
 * Plan detail (M2-03) in the approved design: name, state and who runs it; principal, interest read
 * on chain, shares and the next buy; the full history with receipts (the Activity table); the
 * limits; the guardian; holdings; and, for the judge who owns it, "Stop this plan" (a yield plan's
 * position is redeemed).
 */
import { fromUnits, toUnits } from '@yieldvest/core';
import {
  getPlan,
  latestGuardianSamples,
  openGuardianActions,
  readWorkerStatus,
  usdText,
  type PlanRow,
} from '@yieldvest/db';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { ActivityBoard, type BoardItem } from '../../../components/activity/ActivityBoard';
import { EmptyReceiptPanel, EventRow, ReceiptPanel } from '../../../components/activity/items';
import { StopPlan } from '../../../components/plan/StopPlan';
import {
  ownerText,
  pausedText,
  planName,
  ruleName,
  statusText,
} from '../../../components/plan-text';
import { Toolbar } from '../../../components/Toolbar';
import {
  BlockTitle,
  Pill,
  SectionHeading,
  Status,
  SummaryStrip,
  Unavailable,
  type Tone,
} from '../../../components/ui';
import { bpsPct, grouped, money, moneyFine, sharesText, timeText } from '../../../lib/format';
import { locale } from '../../../lib/i18n/server';
import type { Lang, T } from '../../../lib/i18n/translate';
import { planActivity } from '../../../lib/server/activity';
import { planPositionUsd, webChain } from '../../../lib/server/chain';
import { context } from '../../../lib/server/context';
import { planView } from '../../../lib/server/plan-view';
import { SESSION_COOKIE, verifySession } from '../../../lib/server/session';
import { settle } from '../../../lib/server/settle';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { t } = await locale();
  return { title: `${t('plan.timeline.title')} · ${id}` };
}

type Interest =
  { state: 'LIVE'; usd: string; asOf: string } | { state: 'UNAVAILABLE'; reason: string };

/** Interest so far: the plan's own Venus position (planPositionUsd) minus its principal. */
async function interestOf(row: PlanRow): Promise<Interest> {
  const { config, db } = context();
  if (!db) return { state: 'UNAVAILABLE', reason: 'no database' };
  const venus = (await readWorkerStatus(db, 'venus'))?.value as { vToken?: string } | undefined;
  if (!venus?.vToken) return { state: 'UNAVAILABLE', reason: 'Venus market not verified yet' };
  const position = await planPositionUsd(webChain(config), venus.vToken, row);
  if (position === undefined) return { state: 'UNAVAILABLE', reason: 'no principal deposited yet' };
  const earned = toUnits(position, 18) - toUnits(usdText(row.principalUsd), 18);
  return {
    state: 'LIVE',
    usd: fromUnits(earned > 0n ? earned : 0n, 18),
    asOf: new Date().toISOString(),
  };
}

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { lang, tz, t } = await locale();
  const { config, db } = context();
  const now = new Date();
  const back = { href: '/activity', label: t('nav.activity') };
  const failure = (reason: string) => (
    <>
      <Toolbar t={t} lang={lang} tz={tz} title={t('plan.timeline.title')} back={back} />
      <section className="empty-state">
        <Unavailable t={t} reason={reason} />
      </section>
    </>
  );
  if (!db) return failure('no database');
  const row = await settle('database', () => getPlan(db, id));
  if (!row.ok) return failure(row.reason);
  if (!row.value) notFound();
  const plan = row.value;
  const [view, history, guardian, interest] = await Promise.all([
    settle('database', () => planView(db, config, plan, now)),
    settle('database', () => planActivity(db, plan)),
    settle('database', async () => ({
      latest: await latestGuardianSamples(db),
      open: await openGuardianActions(db, plan.id),
    })),
    plan.mode === 'yield'
      ? settle('chain', () => interestOf(plan))
      : Promise.resolve({ ok: true as const, value: null }),
  ]);
  if (!view.ok) return failure(view.reason);
  const v = view.value;
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const judge =
    session && config.sessionSecret
      ? verifySession(config.sessionSecret, session, now.getTime())
      : undefined;
  const owns =
    plan.ownerKind === 'judge' && judge?.codeHash === plan.ownerRef && v.plan.status !== 'stopped';

  const text = {
    mode: v.plan.mode,
    ticker: v.plan.ticker,
    cadence: v.plan.cadence,
    window: v.plan.window,
    contributionUsd: v.plan.contributionUsd,
    status: v.plan.status,
    pausedReason: v.plan.pausedReason,
  };
  const shares = v.holdings.reduce((sum, h) => sum + Number(h.shares), 0);
  const cost = v.holdings.reduce((sum, h) => sum + Number(h.costUsd), 0);
  const paused = pausedText(t, v.plan.pausedReason);
  const tone: Tone =
    v.plan.status === 'active' ? 'ok' : v.plan.status === 'paused' ? 'wait' : 'skip';
  const next =
    v.plan.status === 'active'
      ? v.plan.mode === 'yield'
        ? `${t('home.house.next.min', { min: money(String(config.caps.minBuyUsd)) })} · ${timeText(v.plan.nextDueAt, lang, tz)}`
        : (timeText(v.plan.nextDueAt, lang, tz) ?? '—')
      : (paused ?? t('plan.next.none'));
  const sharesItem = {
    label: t('home.house.shares'),
    value: (
      <>
        {sharesText(shares.toFixed(18)) ?? '0'} <small>{v.plan.ticker}</small>
      </>
    ),
    note:
      shares > 0
        ? t('plan.summary.average', { avg: money((cost / shares).toFixed(18)) })
        : undefined,
  };
  const interestItem = {
    label: t('home.house.interest'),
    value:
      interest.ok && interest.value?.state === 'LIVE' ? (
        <>
          {moneyFine(interest.value.usd)} <small>USDT</small>
        </>
      ) : (
        '—'
      ),
    note: !interest.ok
      ? t('home.status.unavailable', { reason: interest.reason })
      : interest.value?.state === 'UNAVAILABLE'
        ? t('home.status.unavailable', { reason: interest.value.reason })
        : interest.value
          ? t('home.counter.asof', { time: timeText(interest.value.asOf, lang, tz) })
          : undefined,
  };
  const items: BoardItem[] = history.ok
    ? history.value.map((item) => ({
        key: item.key,
        group: item.kind,
        row: <EventRow t={t} lang={lang} tz={tz} item={item} withPlan={false} />,
        panel: (
          <ReceiptPanel t={t} lang={lang} tz={tz} item={item} eyebrow={t('receipt.eyebrow')} />
        ),
      }))
    : [];
  const used = Number(v.limits.usedTodayUsd);
  const perDay = Number(v.limits.perDayUsd);

  return (
    <>
      <Toolbar t={t} lang={lang} tz={tz} title={planName(t, text)} back={back} />
      <SummaryStrip
        label={t('plan.summary')}
        items={
          v.plan.mode === 'yield'
            ? [
                {
                  label: t('home.house.principal'),
                  value: (
                    <>
                      {grouped(money(v.plan.principalUsd))} <small>USDT</small>
                    </>
                  ),
                },
                interestItem,
                sharesItem,
              ]
            : [
                {
                  label: t('plan.contribution'),
                  value: (
                    <>
                      {money(v.plan.contributionUsd)} <small>USDT</small>
                    </>
                  ),
                },
                sharesItem,
                {
                  label: t('home.house.next'),
                  value: <span className="summary-small">{next}</span>,
                },
              ]
        }
        status={
          <Status tone={tone}>
            {[statusText(t, v.plan.status), ownerText(t, v.plan.owner)].join(' · ')}
          </Status>
        }
      />
      {history.ok ? (
        <ActivityBoard
          lang={lang}
          heading={
            <SectionHeading
              title={t('plan.timeline.title')}
              sub={[paused, v.plan.mode === 'yield' ? `${t('home.house.next')}: ${next}` : null]
                .filter(Boolean)
                .join(' · ')}
            />
          }
          items={items}
          listLabel={t('plan.timeline.title')}
          empty={<EmptyReceiptPanel t={t} eyebrow={t('receipt.eyebrow')} />}
        />
      ) : (
        <div className="page-block">
          <Unavailable t={t} reason={history.reason} />
        </div>
      )}

      <section className="page-block">
        <p className="limits-line">
          {t('plan.limits', {
            perBuy: money(v.limits.perBuyUsd),
            daily: money(v.limits.perDayUsd),
            used: money(v.limits.usedTodayUsd),
          })}
        </p>
        <div
          className="progress-track limits-track"
          role="progressbar"
          aria-label={t('plan.limits.title')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(perDay > 0 ? Math.min(100, (used / perDay) * 100) : 0)}
        >
          <span style={{ transform: `scaleX(${perDay > 0 ? Math.min(1, used / perDay) : 0})` }} />
        </div>
      </section>

      <div className="two-blocks">
        <section className="page-block">
          {guardian.ok ? (
            <GuardianPanel t={t} lang={lang} tz={tz} data={guardian.value} />
          ) : (
            <>
              <BlockTitle>{t('plan.guardian.title')}</BlockTitle>
              <Unavailable t={t} reason={guardian.reason} />
            </>
          )}
        </section>
        <section className="page-block">
          <BlockTitle>{t('plan.holdings.title')}</BlockTitle>
          {v.holdings.length === 0 ? (
            <p>{t('common.none')}</p>
          ) : (
            <ul className="holdings">
              {v.holdings.map((h) => (
                <li key={h.instrumentId}>
                  <strong>
                    {t('plan.holdings.line', {
                      ticker: v.plan.ticker,
                      shares: sharesText(h.shares),
                      avg:
                        Number(h.shares) > 0
                          ? money((Number(h.costUsd) / Number(h.shares)).toFixed(18))
                          : null,
                    })}
                  </strong>
                  <span>
                    {t('plan.holdings.multiplier', {
                      m: Number(h.multiplierAtLastUpdate).toFixed(6),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {owns ? (
        <section className="page-block">
          <BlockTitle>{t('judge.stop.cta')}</BlockTitle>
          <StopPlan planId={plan.id} lang={lang} yieldPlan={v.plan.mode === 'yield'} />
        </section>
      ) : null}
    </>
  );
}

function GuardianPanel({
  t,
  lang,
  tz,
  data,
}: {
  t: T;
  lang: Lang;
  tz: string;
  data: {
    latest: Awaited<ReturnType<typeof latestGuardianSamples>>;
    open: { rule: string; action: string }[];
  };
}) {
  const blocking = data.open.filter((a) => a.action !== 'warn');
  const times = Object.values(data.latest).map((s) => s.ts);
  const last = times.sort().at(-1);
  const utilization = data.latest.venus_utilization_bps?.value;
  const usdt = data.latest.usdt_price_usd?.value;
  const tvl = data.latest.venus_tvl_usd?.value;
  return (
    <>
      <BlockTitle
        aside={
          blocking.length > 0 ? (
            <Pill tone="fail">
              {t('plan.guardian.open', {
                rule: blocking.map((a) => ruleName(t, a.rule)).join(', '),
              })}
            </Pill>
          ) : last ? (
            <Pill tone="ok">{t('plan.guardian.ok', { time: timeText(last, lang, tz) })}</Pill>
          ) : (
            <Pill tone="skip">{t('plan.guardian.nodata')}</Pill>
          )
        }
      >
        {t('plan.guardian.title')}
      </BlockTitle>
      <p>{t('plan.guardian.metrics')}</p>
      <ul className="metric-list">
        <li>
          {utilization ? t('plan.guardian.utilization', { value: bpsPct(utilization) }) : '—'}
        </li>
        <li>{usdt ? t('plan.guardian.usdt', { value: Number(usdt).toFixed(4) }) : '—'}</li>
        <li>
          {tvl
            ? t('plan.guardian.tvl', { value: Math.round(Number(tvl)).toLocaleString('en-US') })
            : '—'}
        </li>
        <li>{t('plan.guardian.impact')}</li>
      </ul>
    </>
  );
}
