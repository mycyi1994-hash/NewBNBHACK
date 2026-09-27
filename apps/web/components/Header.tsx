/**
 * Global header of the approved design: the Yieldvest mark and wordmark, "Built on" the BNB Chain
 * logo (a human decision, DECISIONS D-25), the four tabs and the KO/EN toggle. The market and data
 * states sit in each page's toolbar, next to the title they describe.
 */
import Image from 'next/image';
import Link from 'next/link';
import type { Lang, T } from '../lib/i18n/translate';
import { YieldvestMark } from './Icon';
import { LocaleSync } from './LocaleSync';
import { Nav, type TabId } from './Nav';

export function tabLabels(t: T): Record<TabId, string> {
  return {
    overview: t('nav.overview'),
    earn: t('nav.earn'),
    invest: t('nav.invest'),
    activity: t('nav.activity'),
  };
}

export function Header({ t, lang, tz }: { t: T; lang: Lang; tz: string }) {
  return (
    <header className="app-header">
      <Link className="brand-lockup" href="/" aria-label={t('brand.home')}>
        <span className="yieldvest-logo">
          <YieldvestMark className="yieldvest-mark" />
          <span className="wordmark">Yieldvest</span>
        </span>
        <span className="brand-divider" aria-hidden="true" />
        <span className="chain-lockup">
          <span className="built-on">{t('brand.built_on')}</span>
          <Image
            src="/bnb-chain.svg"
            alt="BNB Chain"
            width={174}
            height={31}
            unoptimized
            loading="eager"
          />
        </span>
      </Link>
      <div className="header-end">
        <Nav labels={tabLabels(t)} ariaLabel={t('nav.main')} />
        <LocaleSync lang={lang} tz={tz} label={t('lang.label')} />
      </div>
    </header>
  );
}
