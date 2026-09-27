/**
 * The execution trace of the approved receipt page, from the cycle's own step log (apps/agent
 * cycle.ts writes one entry per step: INPUTS, QUOTE, EXECUTE, RESERVE, REDEEM, APPROVE, SIMULATED,
 * BOUGHT, AWAITING, DECIDED …). Each line says what the step did with the values it recorded.
 */
import { fromBaseUnits, money, moneyFine } from '../../lib/format';
import type { Lang, T } from '../../lib/i18n/translate';
import { ruleName } from '../plan-text';
import { CheckBadge, whyText } from '../ui';

type Step = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value : null);

interface Line {
  title: string;
  body: string | null;
}

function line(t: T, lang: Lang, tz: string, step: Step): Line | null {
  switch (step.step) {
    case 'INPUTS': {
      const markets = Array.isArray(step.markets) ? step.markets.length : 0;
      return {
        title: t('trace.inputs'),
        body: t('trace.inputs.body', {
          n: markets,
          mode: step.mode === 'live' ? t('trace.mode.live') : t('trace.mode.simulate'),
        }),
      };
    }
    case 'GUARDIAN':
      return {
        title: t('plan.guardian.title'),
        body: t('plan.guardian.open', { rule: ruleName(t, text(step.rule) ?? '') }),
      };
    case 'QUOTE':
      return {
        title: t('trace.quote'),
        body: text(step.errorCode)
          ? t('trace.quote.error', { code: text(step.errorCode) })
          : t('trace.quote.body', { usd: money(text(step.spendUsd)) }),
      };
    case 'REQUOTE':
      return { title: t('trace.requote'), body: null };
    case 'EXECUTE': {
      const decision = (step.decision ?? {}) as Record<string, unknown>;
      return {
        title: t('trace.execute'),
        body: t('trace.execute.body', { usd: money(text(decision.spendUsd)) }),
      };
    }
    case 'RESERVE':
      return {
        title: t('trace.reserve'),
        body: step.ok === false ? t('trace.reserve.refused') : null,
      };
    case 'REDEEM':
      return {
        title: t('trace.redeem'),
        body: t('trace.redeem.body', {
          usd:
            moneyFine(fromBaseUnits(text(step.usdtReceived))) ??
            money(text(step.redeemUsd)) ??
            null,
        }),
      };
    case 'APPROVE':
      return {
        title: t('trace.approve'),
        body: step.via === 'existing_allowance' ? t('trace.approve.existing') : null,
      };
    case 'SIMULATED': {
      const simulation = (step.swapSimulation ?? {}) as Record<string, unknown>;
      return {
        title: t('trace.simulated'),
        body:
          simulation.status === 'SUCCESS'
            ? t('judge.preview.simulated')
            : t('judge.preview.failed', { reason: text(simulation.failReason) ?? '' }),
      };
    }
    case 'BOUGHT':
      return { title: t('trace.bought'), body: null };
    case 'AWAITING':
      return { title: t('trace.awaiting'), body: null };
    case 'ANOMALY':
      return { title: t('trace.anomaly'), body: text(step.message) };
    case 'DECIDED': {
      const why = (step.why ?? null) as { key: string; params: unknown } | null;
      return { title: t('trace.decided'), body: whyText(t, lang, tz, why) };
    }
    default:
      return null;
  }
}

export function Trace({
  t,
  lang,
  tz,
  steps,
  failed,
  finished,
  caption,
}: {
  t: T;
  lang: Lang;
  tz: string;
  steps: Step[];
  failed: boolean;
  finished: boolean;
  caption: string;
}) {
  const lines = steps.map((step) => line(t, lang, tz, step)).filter((l): l is Line => l !== null);
  return (
    <aside className="execution-trace">
      <p className="eyebrow">{t('trace.eyebrow')}</p>
      <h3>{t('trace.title')}</h3>
      {lines.length === 0 ? (
        <p className="trace-caption">{t('trace.none')}</p>
      ) : (
        <ol>
          {lines.map((l, i) => {
            const last = i === lines.length - 1;
            return (
              <li key={i}>
                {last && failed ? (
                  <span className="check-badge fail" aria-hidden="true" />
                ) : (
                  <CheckBadge waiting={last && !finished} />
                )}
                <div>
                  <span className="trace-title">
                    <small>{String(i + 1).padStart(2, '0')}</small>
                    {l.title}
                  </span>
                  {l.body ? <p>{l.body}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="trace-caption">{caption}</p>
    </aside>
  );
}
