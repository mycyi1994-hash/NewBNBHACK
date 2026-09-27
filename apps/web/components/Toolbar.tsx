/**
 * The page toolbar of the approved design: the page title on the left; on the right the US market
 * state from our NYSE calendar, the state of the worker's tape (live, n min old, or unavailable
 * with the reason), the animation pause control and the way to try it with a judge code.
 */
import { nextRegularOpen, regularClose, usSession } from '@yieldvest/core';
import Link from 'next/link';
import type { Lang, T } from '../lib/i18n/translate';
import { context } from '../lib/server/context';
import { tapeView } from '../lib/server/market';
import { settle } from '../lib/server/settle';
import { Icon } from './Icon';
import { MotionToggle } from './motion';
import { dataText, dataTone, MarketBadge, StatusPill, tapeState, type DataState } from './ui';

async function tapeData(now: Date): Promise<DataState> {
  const { db } = context();
  if (!db) return { state: 'UNAVAILABLE', reason: 'no database' };
  const tape = await settle('database', () => tapeView(db, now));
  if (!tape.ok) return { state: 'UNAVAILABLE', reason: tape.reason };
  return tapeState(tape.value, 'no tape yet');
}

export async function Toolbar({
  t,
  lang,
  tz,
  title,
  back,
  cta = true,
}: {
  t: T;
  lang: Lang;
  tz: string;
  title: string;
  back?: { href: string; label: string };
  /** The "Try it" button; off on the page it leads to. */
  cta?: boolean;
}) {
  const now = new Date();
  const data = await tapeData(now);
  return (
    <div className="page-toolbar">
      <div className="toolbar-title">
        {back ? (
          <Link className="back-link" href={back.href}>
            <Icon name="back" size={16} />
            {back.label}
          </Link>
        ) : null}
        <h1 id="page-title" tabIndex={-1}>
          {title}
        </h1>
      </div>
      <div className="toolbar-actions">
        <MarketBadge
          t={t}
          lang={lang}
          tz={tz}
          session={usSession(now)}
          regularClose={regularClose(now)?.toISOString() ?? null}
          nextOpen={nextRegularOpen(now).toISOString()}
        />
        <StatusPill tone={dataTone(data)} title={data.state === 'STALE' ? data.at : undefined}>
          {t('toolbar.data', { state: dataText(t, data, now) })}
        </StatusPill>
        <MotionToggle
          labels={{
            pause: t('motion.pause'),
            play: t('motion.play'),
            reduced: t('motion.reduced'),
          }}
        />
        {cta ? (
          <Link className="button primary" href="/invest">
            {t('nav.judge')}
            <Icon name="right" size={17} />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
