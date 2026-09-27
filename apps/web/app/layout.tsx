import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { tapeState, type DataState } from '../components/ui';
import { locale } from '../lib/i18n/server';
import { COPY } from '../lib/i18n/copy';
import { context } from '../lib/server/context';
import { tapeView } from '../lib/server/market';
import { settle } from '../lib/server/settle';
import './globals.css';

export const metadata: Metadata = {
  title: 'Yieldvest',
  description: COPY.en['home.sub'],
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/** The header's data dot: the worker's tape, as every data view states it. */
async function headerData(now: Date): Promise<DataState> {
  const { db } = context();
  if (!db) return { state: 'UNAVAILABLE', reason: 'no database' };
  const tape = await settle('database', () => tapeView(db, now));
  if (!tape.ok) return { state: 'UNAVAILABLE', reason: tape.reason };
  return tapeState(tape.value, 'no tape yet');
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { lang, tz, t } = await locale();
  const now = new Date();
  return (
    <html lang={lang}>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">
        <Header t={t} lang={lang} tz={tz} now={now} data={await headerData(now)} />
        <main className="mx-auto max-w-[1200px] px-4 py-6 md:py-10">{children}</main>
        <Footer t={t} />
      </body>
    </html>
  );
}
