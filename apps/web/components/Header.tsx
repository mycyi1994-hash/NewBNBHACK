/**
 * Global header (DESIGN_BRIEF §4): wordmark, the five destinations (체험하기 as the button), the
 * US market badge from our NYSE calendar, the tape's data state and the language toggle.
 */
import Link from 'next/link';
import { nextRegularOpen, regularClose, usSession } from '@yieldvest/core';
import type { Lang, T } from '../lib/i18n/translate';
import { LocaleSync } from './LocaleSync';
import { MarketBadge, StateBadge, type DataState } from './ui';

export function Header({
  t,
  lang,
  tz,
  now,
  data,
}: {
  t: T;
  lang: Lang;
  tz: string;
  now: Date;
  data: DataState;
}) {
  const links = [
    { href: '/', label: t('nav.home') },
    { href: '/skill', label: t('nav.skill') },
    { href: '/dx', label: t('nav.dx') },
    { href: '/risk', label: t('nav.risk') },
  ];
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-baseline gap-1.5">
          <span className="text-xl font-extrabold tracking-tight text-ink">Yieldvest</span>
          <span className="text-xs font-semibold text-muted">Yieldvest</span>
        </Link>
        <nav className="order-3 flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium md:order-none md:w-auto">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="text-muted hover:text-ink">
              {link.label}
            </Link>
          ))}
          <Link
            href="/judge"
            className="rounded-full bg-brand px-3 py-1 font-semibold text-white hover:bg-brand-strong"
          >
            {t('nav.judge')}
          </Link>
        </nav>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <MarketBadge
            t={t}
            lang={lang}
            tz={tz}
            session={usSession(now)}
            regularClose={regularClose(now)?.toISOString() ?? null}
            nextOpen={nextRegularOpen(now).toISOString()}
          />
          <StateBadge t={t} data={data} now={now} />
          <LocaleSync lang={lang} tz={tz} label={t('lang.label')} />
        </div>
      </div>
    </header>
  );
}
