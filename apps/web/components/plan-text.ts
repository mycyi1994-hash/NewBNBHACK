/** Plan names, statuses and paused reasons in the viewer's language (UX_COPY §7.3). */
import { money } from '../lib/format';
import { isCopyKey, type T } from '../lib/i18n/translate';

export interface PlanLike {
  mode: string;
  ticker: string | null;
  cadence: string;
  window: string;
  contributionUsd: string;
  status: string;
  pausedReason: string | null;
}

export function planName(t: T, plan: PlanLike): string {
  const cadenceKey = `plan.cadence.${plan.cadence}`;
  const windowKey = `plan.window.${plan.window}`;
  const params = {
    ticker: plan.ticker ?? '',
    cadence: isCopyKey(cadenceKey) ? t(cadenceKey) : plan.cadence,
    window: isCopyKey(windowKey) ? t(windowKey) : plan.window,
    usd: money(plan.contributionUsd),
  };
  return plan.mode === 'yield' ? t('plan.name.yield', params) : t('plan.name.safe', params);
}

export function statusText(t: T, status: string): string {
  const key = `plan.status.${status}`;
  return isCopyKey(key) ? t(key) : status;
}

/**
 * Why a plan is paused or stopped, in words. Every reason the worker and the web write has its
 * own sentence (test/i18n.test.ts); "Paused: {reason}" is left for an operator's free text.
 */
export function pausedText(t: T, reason: string | null): string | null {
  if (!reason) return null;
  // `<reason>:redeem_<kind>`: the pause or stop stands, its redeem did not complete (guardian.ts).
  const held = /^(.+):redeem_[a-z_]+$/.exec(reason)?.[1];
  if (held !== undefined) {
    return t('plan.paused.redeem_held', { reason: pausedText(t, held) ?? held });
  }
  if (reason.startsWith('guardian:')) return t('plan.paused.guardian');
  const key = `plan.paused.${reason}`;
  return isCopyKey(key) ? t(key) : t('plan.paused.other', { reason });
}

export function ownerText(t: T, owner: string): string {
  const key = `plan.owner.${owner}`;
  return isCopyKey(key) ? t(key) : owner;
}

export function ruleName(t: T, rule: string): string {
  const key = `guardian.rule.${rule}`;
  return isCopyKey(key) ? t(key) : rule;
}
