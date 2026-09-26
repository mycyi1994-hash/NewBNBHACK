'use client';
/** The plan history with outcome filter chips (DESIGN_BRIEF §5.3): all / bought / waiting / skipped / failed. */
import { useState } from 'react';
import type { ReactNode } from 'react';

export interface TimelineItem {
  id: number;
  kind: string | null;
  node: ReactNode;
}

export function Timeline({
  items,
  labels,
  empty,
}: {
  items: TimelineItem[];
  labels: { all: string; BOUGHT: string; DEFERRED: string; SKIPPED: string; FAILED: string };
  empty: string;
}) {
  const [filter, setFilter] = useState<string>('all');
  const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter);
  const chips = ['all', 'BOUGHT', 'DEFERRED', 'SKIPPED', 'FAILED'] as const;
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2" role="group">
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            aria-pressed={filter === chip}
            onClick={() => setFilter(chip)}
            className={`rounded-full border px-3 py-1 text-sm font-medium ${
              filter === chip
                ? 'border-ink bg-ink text-white'
                : 'border-line bg-white text-muted hover:text-ink'
            }`}
          >
            {labels[chip]}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-muted">{empty}</p>
      ) : (
        <ol className="divide-y divide-line rounded-2xl border border-line bg-white">
          {shown.map((item) => (
            <li key={item.id} className="p-4">
              {item.node}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
