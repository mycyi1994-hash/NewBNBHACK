/**
 * One activity entry as the approved design shows it: a row of the Activity table (event, amount,
 * state) and the receipt panel beside it. Server-rendered from ActivityItem; every value is a
 * recorded one — the spend and shares from the cycle, the USDT a receipt moved from its logs.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { grouped, money, sharesText, timeText } from '../../lib/format';
import type { CopyKey, Lang, T } from '../../lib/i18n/translate';
import type { ActivityItem } from '../../lib/server/activity';
import { Icon, type IconName } from '../Icon';
import { planName } from '../plan-text';
import { Ledger, OUTCOME_TONE, outcomeText, Panel, Pill, whyText, type Tone } from '../ui';

const ROW_ICON: Record<string, { icon: IconName; className: string }> = {
  BOUGHT: { icon: 'check', className: 'purchase' },
  DEFERRED: { icon: 'clock', className: 'waiting' },
  SKIPPED: { icon: 'minus', className: 'skip' },
  FAILED: { icon: 'x', className: 'fail' },
  SIMULATED: { icon: 'info', className: 'info' },
  deposit: { icon: 'plus', className: 'earned' },
  redeem: { icon: 'back', className: 'earned' },
  approve: { icon: 'check', className: 'info' },
};

export function eventTitle(t: T, item: ActivityItem): string {
  const ticker = item.plan?.ticker ?? '';
  switch (item.kind) {
    case 'BOUGHT':
      return t('activity.event.bought', { ticker });
    case 'SIMULATED':
      return t('activity.event.simulated', { ticker });
    case 'DEFERRED':
      return t('activity.event.deferred', { ticker });
    case 'SKIPPED':
      return t('activity.event.skipped', { ticker });
    case 'FAILED':
      return t('activity.event.failed', { ticker });
    case 'deposit':
      return t('outcome.deposit');
    case 'redeem':
      return t('outcome.redeem');
    case 'approve':
      return t('outcome.approve');
    default:
      return t('activity.event.running', { ticker });
  }
}

/** A transaction outside any cycle: recorded once it is on chain, never "in progress". */
const LONE = new Set(['deposit', 'redeem', 'approve']);

export function eventTone(item: ActivityItem): Tone {
  if (LONE.has(item.kind)) return 'ok';
  return OUTCOME_TONE[item.kind] ?? 'info';
}

function statusText(t: T, item: ActivityItem): string {
  if (LONE.has(item.kind)) return t('activity.status.recorded');
  return outcomeText(t, item.kind);
}

function planLine(t: T, item: ActivityItem): string | null {
  return item.plan ? planName(t, item.plan) : null;
}

/** The cells of one Activity row (the board wraps them in its selectable button). */
export function EventRow({
  t,
  lang,
  tz,
  item,
  withPlan = true,
}: {
  t: T;
  lang: Lang;
  tz: string;
  item: ActivityItem;
  /** Off on a plan's own page, where every row is that plan. */
  withPlan?: boolean;
}) {
  const icon = ROW_ICON[item.kind] ?? { icon: 'clock', className: 'waiting' };
  const tone = eventTone(item);
  const amount = grouped(money(item.spendUsd));
  return (
    <>
      <span className="event-label">
        <span className={`event-icon ${icon.className}`}>
          <Icon name={icon.icon} />
        </span>
        <span>
          {eventTitle(t, item)}
          <small>
            {[timeText(item.at, lang, tz), withPlan ? planLine(t, item) : null]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </span>
      </span>
      <strong className="event-amount">
        {amount ? (
          <>
            {amount} <small>USDT</small>
          </>
        ) : (
          '—'
        )}
      </strong>
      <span className={`event-status ${tone}`}>
        <Icon name={tone === 'ok' ? 'check' : icon.icon} size={16} />
        {statusText(t, item)}
      </span>
    </>
  );
}

const RECEIPT_LINK: Record<string, CopyKey> = {
  approve: 'receipt.link.approve',
  swap: 'receipt.link.swap',
  deposit: 'receipt.link.deposit',
  redeem: 'receipt.link.redeem',
};

export function ReceiptLinks({ t, item }: { t: T; item: ActivityItem }) {
  if (item.receipts.length === 0) return null;
  return (
    <div className="link-row">
      {item.receipts.map((r) => (
        <span key={r.txHash} className="receipt-ref">
          <a
            className="receipt-link"
            href={r.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t(RECEIPT_LINK[r.kind] ?? 'receipt.view')}
          </a>
          {r.indexed ? (
            <small className="receipt-index">
              {r.indexed.agrees
                ? r.indexed.txFee
                  ? `${t('receipt.indexed.agrees')} · ${t('receipt.indexed.fee', { fee: r.indexed.txFee })}`
                  : t('receipt.indexed.agrees')
                : t('receipt.indexed.differs', { status: r.indexed.txStatus })}
            </small>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/** The receipt panel for an entry: what happened, from which money, and the proof. */
export function ReceiptPanel({
  t,
  lang,
  tz,
  item,
  eyebrow,
}: {
  t: T;
  lang: Lang;
  tz: string;
  item: ActivityItem;
  eyebrow: string;
}) {
  const bought = item.kind === 'BOUGHT';
  const rows: [string, ReactNode][] = [];
  if (item.plan) rows.push([t('receipt.plan'), planName(t, item.plan)]);
  if (bought || item.kind === 'SIMULATED') {
    rows.push([
      t('receipt.source'),
      item.interestUsd ? t('receipt.source.interest') : t('receipt.source.contribution'),
    ]);
  }
  if (item.spendUsd) {
    rows.push([
      bought || item.kind === 'SIMULATED' ? t('receipt.spent') : t('receipt.amount'),
      `${grouped(money(item.spendUsd))} USDT`,
    ]);
  }
  if (bought && item.shares) rows.push([t('receipt.shares'), sharesText(item.shares) ?? '—']);
  if (item.receipts.length > 0) rows.push([t('receipt.chain'), 'BNB Smart Chain']);
  const why = whyText(t, lang, tz, item.why);
  return (
    <Panel
      eyebrow={item.receipts.length > 0 ? eyebrow : t('receipt.eyebrow.record')}
      title={eventTitle(t, item)}
      waiting={!bought && !LONE.has(item.kind)}
    >
      <p className="panel-cycle">{timeText(item.at, lang, tz)}</p>
      {item.executionMode === 'simulate' || item.kind === 'SIMULATED' ? (
        <div className="pill-row panel-pills">
          <Pill tone="info">{t('outcome.simulated')}</Pill>
        </div>
      ) : null}
      {rows.length > 0 ? <Ledger rows={rows} /> : null}
      {why ? <p className="panel-note">{why}</p> : null}
      <ReceiptLinks t={t} item={item} />
      {item.cycleId !== null && (item.receipts.length > 0 || item.plan?.owner === 'house') ? (
        <Link className="button dark wide" href={`/activity/${item.cycleId}`}>
          {item.receipts.length > 0 ? t('receipt.inspect') : t('receipt.inspect.record')}
          <Icon name="arrow" size={18} />
        </Link>
      ) : item.plan && item.cycleId === null ? (
        <Link className="button dark wide" href={`/plans/${item.plan.id}`}>
          {t('judge.plan.link')}
          <Icon name="arrow" size={18} />
        </Link>
      ) : null}
    </Panel>
  );
}

/** Nothing recorded yet: the panel keeps its place and says what will fill it. */
export function EmptyReceiptPanel({ t, eyebrow }: { t: T; eyebrow: string }) {
  return (
    <Panel eyebrow={eyebrow} title={t('receipt.none.title')} waiting>
      <p className="panel-note">{t('receipt.none.note')}</p>
      <Link className="button dark wide" href="/invest">
        {t('home.cta.judge')}
        <Icon name="arrow" size={18} />
      </Link>
    </Panel>
  );
}
