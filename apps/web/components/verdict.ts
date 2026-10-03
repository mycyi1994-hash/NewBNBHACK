/**
 * The engine's verdict for one token, in words (UX_COPY §7.7): "Would it buy right now?" on /check
 * and the first screen's "The agent, right now" (PD-06) say it the same way.
 */
import { money, timeText } from '../lib/format';
import { isCopyKey, type Lang, type T } from '../lib/i18n/translate';
import type { IssuerVerdict } from '../lib/server/preflight';
import { whyText, type Tone } from './ui';

export const DECISION_TONE: Record<IssuerVerdict['decision'], Tone> = {
  buy: 'ok',
  wait: 'wait',
  skip: 'skip',
  failed: 'fail',
};

/** The verdict's head line, and its reason when there is one. */
export function verdictLine(t: T, lang: Lang, tz: string, verdict: IssuerVerdict): string[] {
  if (verdict.decision === 'buy') {
    return [
      t('check.verdict.buy', {
        shares: verdict.estimate?.shares,
        usd: money(verdict.spendUsd ?? null),
      }),
    ];
  }
  const head = t(`check.verdict.${verdict.decision}`);
  const why = whyText(t, lang, tz, verdict.why);
  if (why) return [head, why];
  if (verdict.reason) {
    const key = `check.reason.${verdict.reason}`;
    return [head, isCopyKey(key) ? t(key) : t('check.reason.other', { reason: verdict.reason })];
  }
  return [head];
}

/** "Next try …", unless the reason already names that time (market closed, data stale). */
export function retryLine(
  t: T,
  lang: Lang,
  tz: string,
  verdict: IssuerVerdict,
  reason: string | undefined,
): string | null {
  if (!verdict.retryAt) return null;
  const time = timeText(verdict.retryAt, lang, tz);
  if (time === null) return null;
  return reason?.includes(time) ? null : t('check.retry', { time });
}
