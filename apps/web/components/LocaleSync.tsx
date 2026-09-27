'use client';
/**
 * The viewer's time zone (M2-05): the browser reports it once into a cookie the server reads, so
 * every time on the page is local without a second request. The web is English only (D-26).
 */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const YEAR = 60 * 60 * 24 * 365;

export function LocaleSync({ tz }: { tz: string }) {
  const router = useRouter();
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && zone !== tz) {
      document.cookie = `yieldvest_tz=${encodeURIComponent(zone)}; Path=/; Max-Age=${YEAR}; SameSite=Lax`;
      router.refresh();
    }
  }, [tz, router]);
  return null;
}
