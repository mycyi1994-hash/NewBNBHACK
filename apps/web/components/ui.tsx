/**
 * Shared pieces in the approved design: the receipt panel and its ledger, the summary strip, section
 * headings, badges with an icon and text (never colour alone), the data-state badge every data view
 * carries (CLAUDE.md rule 4: live, n min old, or unavailable with the reason), the market badge and
 * the one-line reasons. Safe to use from server and client components alike.
 */
import type { ReactNode } from 'react';
import { displayParams, minutesSince, timeText } from '../lib/format';
import { isCopyKey, type Lang, type T } from '../lib/i18n/translate';
import { Icon, type IconName } from './Icon';

export type Tone = 'ok' | 'wait' | 'skip' | 'fail' | 'info' | 'neutral';

const TONE_ICON: Record<Tone, IconName | null> = {
  ok: 'check',
  wait: 'clock',
  skip: 'minus',
  fail: 'x',
  info: 'info',
  neutral: null,
};

export function Pill({
  tone,
  children,
  icon = true,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  icon?: boolean;
  title?: string;
}) {
  const name = icon ? TONE_ICON[tone] : null;
  return (
    <span className={`pill ${tone}`} title={title}>
      {name ? <Icon name={name} size={14} /> : null}
      <span className="pill-text">{children}</span>
    </span>
  );
}

/** A toolbar status in the approved "demo pill" style: a dot and a short line. */
export function StatusPill({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`demo-pill status-pill ${tone}`} title={title}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}

/** The summary strip's status: a dot and a line, as in the approved design. */
export function Status({ tone = 'ok', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`status ${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export type DataState =
  { state: 'LIVE' } | { state: 'STALE'; at: string } | { state: 'UNAVAILABLE'; reason: string };

export function dataTone(data: DataState): Tone {
  return data.state === 'LIVE' ? 'ok' : data.state === 'STALE' ? 'wait' : 'skip';
}

export function dataText(t: T, data: DataState, now: Date): string {
  if (data.state === 'LIVE') return t('home.status.live');
  if (data.state === 'STALE') return t('home.status.stale', { min: minutesSince(data.at, now) });
  return t('home.status.unavailable', { reason: data.reason });
}

/** Live / {min} min old / Unavailable (with the reason), as UX_COPY §3.1 words them. */
export function StateBadge({ t, data, now }: { t: T; data: DataState; now: Date }) {
  return (
    <Pill tone={dataTone(data)} title={data.state === 'STALE' ? data.at : undefined}>
      {dataText(t, data, now)}
    </Pill>
  );
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
      <StatusPill tone="ok">
        {t('home.market.regular', { close: timeText(regularClose, lang, tz) })}
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="neutral">
      {t('home.market.closed', { open: timeText(nextOpen, lang, tz) })}
    </StatusPill>
  );
}

export const OUTCOME_TONE: Record<string, Tone> = {
  BOUGHT: 'ok',
  DEFERRED: 'wait',
  SKIPPED: 'skip',
  FAILED: 'fail',
  SIMULATED: 'info',
};

export function outcomeText(t: T, kind: string | null | undefined): string {
  // A dry run (simulate mode, or a Judge Mode preview) bought nothing: it says so.
  if (kind === 'SIMULATED') return t('outcome.simulated');
  if (kind === 'BOUGHT' || kind === 'DEFERRED' || kind === 'SKIPPED' || kind === 'FAILED') {
    return t(`outcome.${kind}`);
  }
  return t('outcome.running');
}

export function OutcomeBadge({ t, kind }: { t: T; kind: string | null | undefined }) {
  return <Pill tone={(kind && OUTCOME_TONE[kind]) || 'info'}>{outcomeText(t, kind)}</Pill>;
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
    <a href={href} target="_blank" rel="noopener noreferrer" className="receipt-link">
      {t('receipt.view')}
    </a>
  );
}

/** Tape-derived data state: LIVE, STALE with its time, or UNAVAILABLE with the reason. */
export function tapeState(
  data: { state: string; sampledAt: string | null },
  reason: string,
): DataState {
  if (data.state === 'LIVE') return { state: 'LIVE' };
  if (data.state === 'STALE' && data.sampledAt) return { state: 'STALE', at: data.sampledAt };
  return { state: 'UNAVAILABLE', reason };
}

/** The yellow check (done) or the hollow ring (waiting) of the approved receipt panels. */
export function CheckBadge({ waiting = false }: { waiting?: boolean }) {
  return (
    <span className={`check-badge ${waiting ? 'waiting' : ''}`} aria-hidden="true">
      {waiting ? null : <Icon name="check" size={24} />}
    </span>
  );
}

/** The pale receipt panel of the approved design. */
export function Panel({
  eyebrow,
  title,
  children,
  waiting = false,
  badge = true,
  className = '',
  as: Tag = 'aside',
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  children: ReactNode;
  waiting?: boolean;
  badge?: boolean;
  className?: string;
  as?: 'aside' | 'section';
}) {
  return (
    <Tag className={`receipt-panel ${className}`}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
        </div>
        {badge ? <CheckBadge waiting={waiting} /> : null}
      </div>
      {children}
    </Tag>
  );
}

export function Ledger({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="ledger">
      {rows.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface SummaryItem {
  label: ReactNode;
  value: ReactNode;
  /** A short line under the value: when it was read, or why it is missing. */
  note?: ReactNode;
}

export function SummaryStrip({
  label,
  items,
  status,
}: {
  label: string;
  items: SummaryItem[];
  status?: ReactNode;
}) {
  return (
    <section className="summary-strip" aria-label={label}>
      {items.map((item, index) => (
        <div className="summary-stat" key={index}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.note ? <small className="summary-note">{item.note}</small> : null}
        </div>
      ))}
      <div className="summary-status">{status}</div>
    </section>
  );
}

export function SectionHeading({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {sub ? <p>{sub}</p> : null}
    </div>
  );
}

/** A data view that has no value to show says why, in place of the number (CLAUDE.md rule 4). */
export function Unavailable({ t, reason }: { t: T; reason: string }) {
  return (
    <p className="state-line">
      <Icon name="info" size={16} />
      <span>{t('home.status.unavailable', { reason })}</span>
    </p>
  );
}

/** A heading for the secondary blocks of a page (tables, lists), with an optional status. */
export function BlockTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="block-title">
      <h2>{children}</h2>
      {aside}
    </div>
  );
}
