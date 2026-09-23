import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { copy } from '../lib/copy';
import './globals.css';

export const metadata: Metadata = {
  title: '이자로 (Ijaro)',
  description: copy['home.sub'].en,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-white text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
