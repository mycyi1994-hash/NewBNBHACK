/**
 * Plan detail (M2-03, DESIGN_BRIEF §5.3): name, status and who runs it; principal, interest read
 * on chain, shares and the next buy; the limits; the guardian; the full history with receipts;
 * and, for the judge who owns it, "플랜 멈추기" (a yield plan's position is redeemed).
 */
import { fromUnits, toUnits } from '@ijaro/core';
import {
  getPlan,
  latestGuardianSamples,
  openGuardianActions,
  readWorkerStatus,
  usdText,
  type PlanRow,
} from '@ijaro/db';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StopPlan } from '../../../components/plan/StopPlan';
import { Timeline } from '../../../components/plan/Timeline';
import {
  ownerText,
  pausedText,
  planName,
  ruleName,
  statusText,
} from '../../../components/plan-text';
import {
  Card,
  OutcomeBadge,
  Pill,
  ReceiptLink,
  SectionTitle,
  Stat,
  StateBadge,
  whyText,
} from '../../../components/ui';
import { bpsPct, money, sharesText, timeText } from '../../../lib/format';
import { locale } from '../../../lib/i18n/server';
import type { T } from '../../../lib/i18n/translate';
import { webChain } from '../../../lib/server/chain';
import { context } from '../../../lib/server/context';
import { planView } from '../../../lib/server/plan-view';
import { SESSION_COOKIE, verifySession } from '../../../lib/server/session';
import { settle } from '../../../lib/server/settle';

export const dynamic = 'force-dynamic';

type Interest =
  { state: 'LIVE'; usd: string; asOf: string } | { state: 'UNAVAILABLE'; reason: string };

/** Interest so far: the plan's vTokens (house, judge) or its wallet's position (skill) minus principal. */
async function interestOf(row: PlanRow): Promise<Interest> {
  const { config, db } = context();
  if (!db) return { state: 'UNAVAILABLE', reason: 'no database' };
  const venus = (await readWorkerStatus(db, 'venus'))?.value as { vToken?: string } | undefined;
  if (!venus?.vToken) return { state: 'UNAVAILABLE', reason: 'Venus market not verified yet' };
  const chain = webChain(config);
  const vTokens = BigInt(row.vtokenUnits);
  const position =
    row.ownerKind === 'skill' && row.walletAddress
      ? await chain.venusPositionUsd(venus.vToken, row.walletAddress)
      : vTokens > 0n
        ? await chain.vTokensUsd(venus.vToken, vTokens)
        : null;
  if (position === null) return { state: 'UNAVAILABLE', reason: 'no principal deposited yet' };
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
  if (!db)
    return <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: 'no database' }} now={now} />;
  const row = await settle('database', () => getPlan(db, id));
  if (!row.ok)
    return <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: row.reason }} now={now} />;
  if (!row.value) notFound();
  const plan = row.value;
  const [view, guardian, interest] = await Promise.all([
    settle('database', () => planView(db, config, plan, now)),
    settle('database', async () => ({
      latest: await latestGuardianSamples(db),
      open: await openGuardianActions(db, plan.id),
    })),
    plan.mode === 'yield'
      ? settle('chain', () => interestOf(plan))
      : Promise.resolve({ ok: true as const, value: null }),
  ]);
  if (!view.ok)
    return <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: view.reason }} now={now} />;
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
  const used = Number(v.limits.perDayUsd) - Number(v.limits.remainingTodayUsd);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/" className="text-sm text-muted hover:text-ink">
          ← {t('nav.home')}
        </Link>
        <h1 className="mt-2 text-2xl font-extrabold md:text-3xl">{planName(t, text)}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Pill
            tone={v.plan.status === 'active' ? 'ok' : v.plan.status === 'paused' ? 'wait' : 'skip'}
          >
            {statusText(t, v.plan.status)}
          </Pill>
          <Pill tone="neutral" icon={false}>
            {ownerText(t, v.plan.owner)}
          </Pill>
          {paused ? <span className="text-sm text-muted">{paused}</span> : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {v.plan.mode === 'yield' ? (
          <>
            <Card>
              <Stat label={t('home.house.principal')} value={`$${money(v.plan.principalUsd)}`} />
            </Card>
            <Card>
              <Stat
                label={t('home.house.interest')}
                value={
                  interest.ok && interest.value?.state === 'LIVE'
                    ? `$${money(interest.value.usd)}`
                    : '—'
                }
                sub={
                  !interest.ok
                    ? t('home.status.unavailable', { reason: interest.reason })
                    : interest.value?.state === 'UNAVAILABLE'
                      ? t('home.status.unavailable', { reason: interest.value.reason })
                      : interest.value
                        ? t('home.counter.asof', { time: timeText(interest.value.asOf, lang, tz) })
                        : undefined
                }
              />
            </Card>
          </>
        ) : null}
        <Card>
          <Stat
            label={t('home.house.shares')}
            value={sharesText(shares.toFixed(18)) ?? '0'}
            sub={
              shares > 0
                ? t('plan.summary.average', { avg: money((cost / shares).toFixed(18)) })
                : undefined
            }
          />
        </Card>
        <Card>
          <Stat
            label={t('home.house.next')}
            value={
              <span className="text-base">
                {v.plan.status === 'active'
                  ? timeText(v.plan.nextDueAt, lang, tz)
                  : (paused ?? t('plan.next.none'))}
              </span>
            }
          />
        </Card>
      </div>

      <Card>
        <p className="num font-medium">
          {t('plan.limits', {
            perBuy: money(v.limits.perBuyUsd),
            daily: money(v.limits.perDayUsd),
            used: money(Math.max(0, used).toFixed(18)),
          })}
        </p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-canvas" aria-hidden="true">
          <div
            className="h-full rounded-full bg-brand"
            style={{
              width: `${Math.min(100, (Math.max(0, used) / Number(v.limits.perDayUsd)) * 100).toFixed(1)}%`,
            }}
          />
        </div>
      </Card>

      <Card>
        <SectionTitle>{t('plan.guardian.title')}</SectionTitle>
        {guardian.ok ? (
          <GuardianPanel t={t} lang={lang} tz={tz} data={guardian.value} />
        ) : (
          <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: guardian.reason }} now={now} />
        )}
      </Card>

      <section>
        <SectionTitle>{t('plan.timeline.title')}</SectionTitle>
        <Timeline
          labels={{
            all: t('plan.timeline.all'),
            BOUGHT: t('outcome.BOUGHT'),
            DEFERRED: t('outcome.DEFERRED'),
            SKIPPED: t('outcome.SKIPPED'),
            FAILED: t('outcome.FAILED'),
          }}
          empty={t('home.feed.empty')}
          items={v.cycles.map((c) => {
            const outcome = c.outcome as { kind?: string; interestUsd?: string | null } | null;
            const receipts = v.receipts.filter((r) => r.cycleId === c.id);
            return {
              id: c.id,
              kind: outcome?.kind ?? null,
              node: (
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="num text-sm text-muted">
                      {timeText(c.startedAt, lang, tz)}
                    </span>
                    <OutcomeBadge t={t} kind={outcome?.kind ?? null} />
                    {c.executionMode === 'simulate' ? (
                      <Pill tone="neutral" icon={false}>
                        {t('outcome.simulated')}
                      </Pill>
                    ) : null}
                    {outcome?.kind === 'BOUGHT' && outcome.interestUsd ? (
                      <Pill tone="neutral" icon={false}>
                        {t('outcome.interest_only')}
                      </Pill>
                    ) : null}
                  </div>
                  <p className="text-sm">{whyText(t, lang, tz, c.why)}</p>
                  <div className="flex flex-wrap gap-3">
                    {receipts.map((r) => (
                      <ReceiptLink key={r.txHash} t={t} href={r.explorerUrl} />
                    ))}
                  </div>
                </div>
              ),
            };
          })}
        />
      </section>

      {v.receipts.some((r) => r.cycleId === null) ? (
        <Card>
          <SectionTitle>{t('home.feed.title')}</SectionTitle>
          <ul className="flex flex-col gap-2">
            {v.receipts
              .filter((r) => r.cycleId === null)
              .map((r) => (
                <li key={r.txHash} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="num text-muted">{timeText(r.at, lang, tz)}</span>
                  <Pill tone="info">
                    {r.kind === 'redeem' ? t('outcome.redeem') : t('outcome.deposit')}
                  </Pill>
                  <ReceiptLink t={t} href={r.explorerUrl} />
                </li>
              ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <SectionTitle>{t('plan.holdings.title')}</SectionTitle>
        {v.holdings.length === 0 ? (
          <p className="text-muted">{t('common.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {v.holdings.map((h) => (
              <li key={h.instrumentId} className="num">
                {t('plan.holdings.line', {
                  ticker: v.plan.ticker,
                  shares: sharesText(h.shares),
                  avg:
                    Number(h.shares) > 0
                      ? money((Number(h.costUsd) / Number(h.shares)).toFixed(18))
                      : null,
                })}
                <span className="ml-2 text-xs text-muted">
                  {t('plan.holdings.multiplier', {
                    m: Number(h.multiplierAtLastUpdate).toFixed(6),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {owns ? (
        <Card>
          <StopPlan planId={plan.id} lang={lang} yieldPlan={v.plan.mode === 'yield'} />
        </Card>
      ) : null}
    </div>
  );
}

function GuardianPanel({
  t,
  lang,
  tz,
  data,
}: {
  t: T;
  lang: 'ko' | 'en';
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
    <div className="flex flex-col items-start gap-3">
      {blocking.length > 0 ? (
        <Pill tone="fail">
          {t('plan.guardian.open', { rule: blocking.map((a) => ruleName(t, a.rule)).join(', ') })}
        </Pill>
      ) : last ? (
        <Pill tone="ok">{t('plan.guardian.ok', { time: timeText(last, lang, tz) })}</Pill>
      ) : (
        <Pill tone="skip">{t('plan.guardian.nodata')}</Pill>
      )}
      <div className="text-sm font-semibold text-muted">{t('plan.guardian.metrics')}</div>
      <ul className="num grid w-full gap-1 text-sm sm:grid-cols-2">
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
    </div>
  );
}
