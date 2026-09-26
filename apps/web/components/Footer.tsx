/** Global footer (DESIGN_BRIEF §4): the short risk line, the APIs used (text only), links. */
import Link from 'next/link';
import type { T } from '../lib/i18n/translate';

export const REPO_URL = 'https://github.com/mycyi1994-hash/NewBNBHACK';

export function Footer({ t }: { t: T }) {
  return (
    <footer className="mt-16 border-t border-line bg-canvas">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-3 px-4 py-8 text-sm text-muted">
        <p className="font-semibold text-ink">{t('footer.risk')}</p>
        <p>{t('footer.simulate')}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <Link href="/risk" className="hover:text-ink">
            {t('nav.risk')}
          </Link>
          <Link href="/dx" className="hover:text-ink">
            {t('nav.dx')}
          </Link>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="hover:text-ink">
            {t('footer.github')}
          </a>
        </div>
        <p className="text-xs">{t('footer.apis')}</p>
      </div>
    </footer>
  );
}
