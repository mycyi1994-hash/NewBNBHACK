/**
 * /risk (M2-04, UX_COPY §5): the full disclosure with today's rate and the platform's security
 * score as the worker recorded them (with when), and the safe default.
 */
import { RiskText } from '../../components/RiskText';
import { Card, Pill, StateBadge } from '../../components/ui';
import { bpsPct, timeText } from '../../lib/format';
import { locale } from '../../lib/i18n/server';
import { context } from '../../lib/server/context';
import { venusInfo } from '../../lib/server/house';
import { settle } from '../../lib/server/settle';

export const dynamic = 'force-dynamic';

export default async function RiskPage() {
  const { lang, tz, t } = await locale();
  const { db } = context();
  const now = new Date();
  const venus = db ? await settle('database', () => venusInfo(db)) : null;
  const apy = venus?.ok ? bpsPct(venus.value.apyBps) : null;
  const score = venus?.ok ? venus.value.securityScore : null;
  const updated = venus?.ok
    ? [venus.value.apyAt, venus.value.scoreAt].filter(Boolean).sort()[0]
    : null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-3xl font-extrabold">{t('nav.risk')}</h1>
      <Card>
        <RiskText lang={lang} apy={apy} score={score} />
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted">
          {apy && score && updated ? (
            <>
              <Pill tone="ok">{t('home.status.live')}</Pill>
              <span>{t('common.updated', { time: timeText(updated, lang, tz) })}</span>
            </>
          ) : (
            <StateBadge
              t={t}
              data={{
                state: 'UNAVAILABLE',
                reason: venus && !venus.ok ? venus.reason : 'rate not recorded yet',
              }}
              now={now}
            />
          )}
        </div>
      </Card>
      <p className="rounded-xl bg-brand-soft px-4 py-3 font-medium text-ok">
        {t('risk.page.default')}
      </p>
    </div>
  );
}
