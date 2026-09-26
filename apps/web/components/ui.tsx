/**
 * Shared pieces (DESIGN_BRIEF §6): cards, badges with icon + text (never colour alone), the data
 * state badge every data block carries (CLAUDE.md rule 4), the market badge and reason lines.
 */
import type { ReactNode } from 'react';
import { displayParams, minutesSince, timeText } from '../lib/format';
import { isCopyKey, type Lang, type T } from '../lib/i18n/translate';

export type Tone = 'ok' | 'wait' | 'skip' | 'fail' | 'info' | 'neutral';

const TONES: Record<Tone, string> = {
  ok: 'bg-brand-soft text-ok',
  wait: 'bg-wait-soft text-wait',
  skip: 'bg-skip-soft text-skip',
  fail: 'bg-fail-soft text-fail',
  info: 'bg-info-soft text-info',
  neutral: 'bg-canvas text-muted',
};

const ICONS: Record<Tone, string> = {
  ok: '✓',
  wait: '◷',
  skip: '–',
  fail: '✕',
  info: 'i',
  neutral: '•',
};

export function Pill({
  tone,
  children,
  icon = true,
}: {
  tone: Tone;
  children: ReactNode;
  icon?: boolean;
}) {
  return (
    <span
      className={`inline-flex w-fit max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}
    >
      {icon ? <span aria-hidden="true">{ICONS[tone]}</span> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-2xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(17,20,24,0.04)] ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-bold text-ink">{children}</h2>
      {aside}
    </div>
  );
}

export type DataState =
  { state: 'LIVE' } | { state: 'STALE'; at: string } | { state: 'UNAVAILABLE'; reason: string };

/** LIVE / n분 전 / 불러올 수 없음 (with the reason), as UX_COPY §3.1 words them. */
export function StateBadge({ t, data, now }: { t: T; data: DataState; now: Date }) {
  if (data.state === 'LIVE') return <Pill tone="ok">{t('home.status.live')}</Pill>;
  if (data.state === 'STALE') {
    return (
      <span title={data.at}>
        <Pill tone="wait">{t('home.status.stale', { min: minutesSince(data.at, now) })}</Pill>
      </span>
    );
  }
  return <Pill tone="skip">{t('home.status.unavailable', { reason: data.reason })}</Pill>;
}

export function MarketBadge({
  t,
  lang,
  tz,
  session,
  regularClose,
  nextOpen,
}: {
  t: T;
  lang: Lang;
  tz: string;
  session: string;
  regularClose: string | null;
  nextOpen: string;
}) {
  if (session === 'regular' && regularClose) {
    return (
      <Pill tone="ok">{t('home.market.regular', { close: timeText(regularClose, lang, tz) })}</Pill>
    );
  }
  return (
    <Pill tone="neutral">{t('home.market.closed', { open: timeText(nextOpen, lang, tz) })}</Pill>
  );
}

const OUTCOME_TONE: Record<string, Tone> = {
  BOUGHT: 'ok',
  DEFERRED: 'wait',
  SKIPPED: 'skip',
  FAILED: 'fail',
};

export function OutcomeBadge({ t, kind }: { t: T; kind: string | null | undefined }) {
  // A dry run (simulate mode, or a Judge Mode preview) bought nothing: it says so.
  if (kind === 'SIMULATED') return <Pill tone="info">{t('outcome.simulated')}</Pill>;
  if (kind === 'BOUGHT' || kind === 'DEFERRED' || kind === 'SKIPPED' || kind === 'FAILED') {
    return <Pill tone={OUTCOME_TONE[kind] ?? 'neutral'}>{t(`outcome.${kind}`)}</Pill>;
  }
  return <Pill tone="info">{t('outcome.running')}</Pill>;
}

/** The one-line reason (UX_COPY §4) in the viewer's language, times in their zone. */
export function whyText(
  t: T,
  lang: Lang,
  tz: string,
  why: { key: string; params: unknown } | null | undefined,
): string | null {
  if (!why || !isCopyKey(why.key)) return null;
  const params = displayParams(why.params as Record<string, unknown> | null, lang, tz);
  if (params.rule) {
    const ruleKey = `guardian.rule.${params.rule}`;
    if (isCopyKey(ruleKey)) params.rule = t(ruleKey);
  }
  return t(why.key, params);
}

export function ReceiptLink({ t, href }: { t: T; href: string | null | undefined }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="whitespace-nowrap text-sm font-medium text-brand underline-offset-2 hover:underline"
    >
      {t('receipt.view')}
    </a>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-sm text-muted">{label}</div>
      <div className="num mt-1 text-xl font-bold text-ink">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

export const buttonClass = {
  primary:
    'inline-flex items-center justify-center rounded-xl bg-brand px-5 py-3 text-base font-semibold text-white hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50',
  secondary:
    'inline-flex items-center justify-center rounded-xl border border-line bg-white px-5 py-3 text-base font-semibold text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50',
  danger:
    'inline-flex items-center justify-center rounded-xl border border-fail px-5 py-3 text-base font-semibold text-fail hover:bg-fail-soft disabled:cursor-not-allowed disabled:opacity-50',
};

/** Tape-derived data state: LIVE, STALE with its time, or UNAVAILABLE with the reason. */
export function tapeState(
  data: { state: string; sampledAt: string | null },
  reason: string,
): DataState {
  if (data.state === 'LIVE') return { state: 'LIVE' };
  if (data.state === 'STALE' && data.sampledAt) return { state: 'STALE', at: data.sampledAt };
  return { state: 'UNAVAILABLE', reason };
}
