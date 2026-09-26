import Link from 'next/link';
import { locale } from '../lib/i18n/server';

export default async function NotFound() {
  const { t } = await locale();
  return (
    <div className="flex flex-col items-start gap-4 py-10">
      <h1 className="text-2xl font-extrabold">{t('common.notfound')}</h1>
      <Link href="/" className="font-medium text-brand hover:underline">
        ← {t('nav.home')}
      </Link>
    </div>
  );
}
