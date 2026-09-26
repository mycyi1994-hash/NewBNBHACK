'use client';
/**
 * The house yield plan's interest so far (DESIGN_BRIEF §5.1 ①): read on chain by the server and
 * refreshed every 15 seconds — the value shown is always a reading, never an extrapolation.
 */
import { useEffect, useState } from 'react';
import { money, money6, timeText } from '../../lib/format';
import { translate, type Lang } from '../../lib/i18n/translate';

export interface CounterValue {
  state: 'LIVE' | 'UNAVAILABLE';
  usd: string | null;
  reason?: string;
  asOf?: string;
}

const REFRESH_MS = 15_000;

export function InterestCounter({
  lang,
  planId,
  initial,
  minBuyUsd,
  tz,
}: {
  lang: Lang;
  planId: string;
  initial: CounterValue;
  minBuyUsd: string;
  tz: string;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const timer = setInterval(() => {
      void fetch('/api/house', { cache: 'no-store' })
        .then((res) =>
          res.ok
            ? (res.json() as Promise<{ plans: { id: string; interest: CounterValue }[] }>)
            : null,
        )
        .then((body) => {
          const next = body?.plans.find((p) => p.id === planId)?.interest;
          if (next) setValue(next);
        })
        .catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [planId]);
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(lang, key, params);

  if (value.state !== 'LIVE' || value.usd === null) {
    return (
      <div>
        <div className="num text-4xl font-extrabold text-muted">$—</div>
        <p className="mt-2 text-sm text-muted">
          {t('home.status.unavailable', { reason: value.reason ?? '' })}
        </p>
      </div>
    );
  }
  const earned = Number(value.usd);
  const min = Number(minBuyUsd);
  const progress = min > 0 ? Math.min(1, earned / min) : 0;
  const left = Math.max(0, min - earned).toFixed(18);
  return (
    <div>
      <div className="num text-4xl font-extrabold text-ink md:text-5xl">${money6(value.usd)}</div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-canvas" aria-hidden="true">
        <div
          className="h-full rounded-full bg-brand"
          style={{ width: `${(progress * 100).toFixed(1)}%` }}
        />
      </div>
      <p className="num mt-2 text-sm text-muted">
        {t('home.house.next.progress', { left: money(left) })}
      </p>
      {value.asOf ? (
        <p className="mt-1 text-xs text-muted">
          {t('home.counter.asof', { time: timeText(value.asOf, lang, tz) })}
        </p>
      ) : null}
    </div>
  );
}
