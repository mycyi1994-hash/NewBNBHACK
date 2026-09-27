/**
 * /risk (M2-04, UX_COPY §5) in the approved design: the full disclosure as a document, with today's
 * rate and the platform's security score as the worker recorded them (with when), and the safe
 * default.
 */
import type { Metadata } from 'next';
import { Icon } from '../../components/Icon';
import { RiskText } from '../../components/RiskText';
import { Toolbar } from '../../components/Toolbar';
import { Pill, StateBadge } from '../../components/ui';
import { timeText } from '../../lib/format';
import { locale } from '../../lib/i18n/server';
import { context } from '../../lib/server/context';
import { venusInfo } from '../../lib/server/house';
import { settle } from '../../lib/server/settle';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: t('nav.risk') };
}

export default async function RiskPage() {
  const { lang, tz, t } = await locale();
  const { db } = context();
  const now = new Date();
  const venus = db ? await settle('database', () => venusInfo(db)) : null;
  const apy = venus?.ok ? venus.value.apy : null;
  const score = venus?.ok ? venus.value.securityScore : null;
  const updated = venus?.ok
    ? [venus.value.apyAt, venus.value.scoreAt].filter(Boolean).sort()[0]
    : null;
  return (
    <>
      <Toolbar t={t} lang={lang} tz={tz} title={t('nav.risk')} />
      <section className="receipt-document risk-document">
        <div className="document-meta">
          <span>Venus · USDT</span>
          <span>{updated ? t('common.updated', { time: timeText(updated, lang, tz) }) : null}</span>
        </div>
        <div className="document-title">
          <h2>{t('footer.risk')}</h2>
        </div>
        <div className="pill-row panel-pills">
          {apy && score && updated ? (
            venus?.ok && venus.value.fresh ? (
              <Pill tone="ok">{t('home.status.live')}</Pill>
            ) : (
              <StateBadge t={t} data={{ state: 'STALE', at: updated }} now={now} />
            )
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
        <div className="risk-body">
          <RiskText lang={lang} apy={apy} score={score} />
        </div>
        <div className="receipt-disclaimer live">
          <Icon name="info" />
          <span>{t('risk.page.default')}</span>
        </div>
      </section>
    </>
  );
}
