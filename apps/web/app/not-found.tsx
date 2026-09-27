import Link from 'next/link';
import { Icon } from '../components/Icon';
import { locale } from '../lib/i18n/server';

export default async function NotFound() {
  const { t } = await locale();
  return (
    <section className="empty-state">
      <Icon name="activity" size={36} />
      <h1 id="page-title" tabIndex={-1}>
        {t('common.notfound')}
      </h1>
      <Link className="button primary" href="/">
        {t('nav.overview')}
        <Icon name="right" size={17} />
      </Link>
    </section>
  );
}
