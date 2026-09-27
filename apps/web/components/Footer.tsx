/**
 * Global footer in the approved layout: the risk line, how every buy is checked first, the other
 * pages (risks, the AI assistant, data, source code) and the APIs used, as text only.
 */
import Link from 'next/link';
import type { T } from '../lib/i18n/translate';

export const REPO_URL = 'https://github.com/mycyi1994-hash/NewBNBHACK';

export function Footer({ t }: { t: T }) {
  return (
    <footer className="footer-block">
      <div className="app-footer">
        <span>{t('footer.risk')}</span>
        <span>{t('footer.simulate')}</span>
        <span className="footer-links">
          <Link href="/risk">{t('nav.risk')}</Link>
          <Link href="/skill">{t('nav.skill')}</Link>
          <Link href="/dx">{t('nav.dx')}</Link>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            {t('footer.github')}
          </a>
        </span>
      </div>
      <p className="footer-note">{t('footer.apis')}</p>
    </footer>
  );
}
