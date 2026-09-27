import '@fontsource-variable/inter';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Footer } from '../components/Footer';
import { Header, tabLabels } from '../components/Header';
import { MotionProvider, PageMotion } from '../components/motion';
import { Nav } from '../components/Nav';
import { locale } from '../lib/i18n/server';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return {
    title: { default: `Yieldvest — ${t('brand.tagline')}`, template: '%s · Yieldvest' },
    description: t('home.sub'),
    applicationName: 'Yieldvest',
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0b0e11',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { lang, tz, t } = await locale();
  return (
    <html lang={lang}>
      <body>
        <MotionProvider>
          <a className="skip-link" href="#main">
            {t('common.skip')}
          </a>
          <div className="app-shell">
            <Header t={t} lang={lang} tz={tz} />
            <main id="main" tabIndex={-1}>
              <PageMotion>{children}</PageMotion>
            </main>
            <Footer t={t} />
          </div>
          <Nav labels={tabLabels(t)} ariaLabel={t('nav.mobile')} mobile />
        </MotionProvider>
      </body>
    </html>
  );
}
