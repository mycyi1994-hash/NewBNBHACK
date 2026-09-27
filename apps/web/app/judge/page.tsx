/**
 * Judge Mode (M2-02, DESIGN_BRIEF §5.2): a judge code to a real receipt in about three minutes.
 * The server only checks the code, creates the sandbox plan and queues work; the worker signs.
 */
import { cookies } from 'next/headers';
import { JudgeFlow, type Venue } from '../../components/judge/JudgeFlow';
import { StateBadge } from '../../components/ui';
import { locale } from '../../lib/i18n/server';
import { context } from '../../lib/server/context';
import { venusInfo } from '../../lib/server/house';
import { judgeRemaining } from '../../lib/server/judge';
import { marketStatus } from '../../lib/server/market';
import { SESSION_COOKIE, verifySession } from '../../lib/server/session';
import { settle } from '../../lib/server/settle';

export const dynamic = 'force-dynamic';

export default async function JudgePage() {
  const { lang, tz, t } = await locale();
  const { config, db } = context();
  const now = new Date();
  if (!db)
    return <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: 'no database' }} now={now} />;
  const [market, venus] = await Promise.all([
    settle('database', () => marketStatus(db, now)),
    settle('database', () => venusInfo(db)),
  ]);
  if (!market.ok)
    return <StateBadge t={t} data={{ state: 'UNAVAILABLE', reason: market.reason }} now={now} />;

  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const session =
    cookie && config.sessionSecret
      ? verifySession(config.sessionSecret, cookie, now.getTime())
      : undefined;
  const budget = session
    ? await settle('database', () => judgeRemaining(db, config, session.codeHash, now))
    : null;

  const venues: Venue[] = market.value.instruments.map((i) => ({
    ticker: i.ticker,
    issuer: i.issuer,
    symbol: i.symbol,
    address: i.address,
    venueMinUsd: i.venueMinUsd,
    reasonCode: i.reasonCode,
  }));
  return (
    <JudgeFlow
      lang={lang}
      tz={tz}
      capUsd={String(config.caps.sandboxMaxPerPlanUsd)}
      minBuyUsd={String(config.caps.minBuyUsd)}
      market={{
        session: market.value.session,
        regularClose: market.value.regularClose,
        nextBuyWindow: market.value.nextBuyWindow,
        nextRegularOpen: market.value.nextRegularOpen,
      }}
      venues={venues}
      session={budget?.ok ? { remainingUsd: budget.value.remainingUsd } : null}
      risk={{
        apy: venus.ok && venus.value.fresh ? venus.value.apy : null,
        score: venus.ok && venus.value.fresh ? venus.value.securityScore : null,
      }}
    />
  );
}
