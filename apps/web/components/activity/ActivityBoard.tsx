'use client';
/**
 * The Activity table of the approved design with its filters and the receipt panel of the selected
 * entry. Rows and panels are rendered on the server from recorded data; this only filters and
 * selects (UX: the same outcome chips as a plan's history).
 */
import { useState, type ReactNode } from 'react';
import { translate, type Lang } from '../../lib/i18n/translate';

export interface BoardItem {
  key: string;
  /** The filter it belongs to: BOUGHT, DEFERRED, SKIPPED, FAILED, or anything else (All only). */
  group: string;
  row: ReactNode;
  panel: ReactNode;
}

export const FILTERS = ['all', 'BOUGHT', 'DEFERRED', 'SKIPPED', 'FAILED'] as const;

export function ActivityBoard({
  lang,
  heading,
  items,
  empty,
  listLabel,
}: {
  lang: Lang;
  heading: ReactNode;
  items: BoardItem[];
  /** The panel shown when nothing is selected or recorded. */
  empty: ReactNode;
  listLabel: string;
}) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(lang, key, params);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [selected, setSelected] = useState<string | null>(items[0]?.key ?? null);
  const visible = items.filter((item) => filter === 'all' || item.group === filter);
  const active = visible.find((item) => item.key === selected) ?? visible[0];
  const label = (value: (typeof FILTERS)[number]) =>
    value === 'all' ? t('plan.timeline.all') : t(`outcome.${value}`);
  return (
    <div className="workspace-grid">
      <section className="visual-workspace">
        {heading}
        <div className="filter-group" role="group" aria-label={t('activity.filter')}>
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label(value)}
            </button>
          ))}
        </div>
        <div className="activity-table">
          <div className="activity-table-heading" aria-hidden="true">
            <span>{t('activity.col.event')}</span>
            <span>{t('activity.col.amount')}</span>
            <span>{t('activity.col.status')}</span>
          </div>
          <div className="activity-list" role="group" aria-label={listLabel}>
            {visible.map((item) => (
              <button
                type="button"
                className={`activity-row ${item.key === active?.key ? 'selected' : ''}`}
                aria-pressed={item.key === active?.key}
                onClick={() => setSelected(item.key)}
                key={item.key}
              >
                {item.row}
              </button>
            ))}
          </div>
          {visible.length === 0 ? <p className="activity-empty">{t('home.feed.empty')}</p> : null}
          <p className="list-caption">
            {t('activity.count', { shown: visible.length, total: items.length })}
          </p>
        </div>
      </section>
      {active ? active.panel : empty}
    </div>
  );
}
