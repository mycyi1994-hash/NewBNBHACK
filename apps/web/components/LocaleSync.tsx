'use client';
/**
 * The language toggle (M2-05) and the viewer's time zone: both live in cookies the server reads,
 * so every page renders in one language and in local time without a second request.
 */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { Lang } from '../lib/i18n/translate';

const YEAR = 60 * 60 * 24 * 365;

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${YEAR}; SameSite=Lax`;
}

export function LocaleSync({ lang, tz, label }: { lang: Lang; tz: string; label: string }) {
  const router = useRouter();
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && zone !== tz) {
      setCookie('yieldvest_tz', zone);
      router.refresh();
    }
  }, [tz, router]);
  const choose = (next: Lang) => {
    if (next === lang) return;
    setCookie('yieldvest_lang', next);
    router.refresh();
  };
  return (
    <div role="group" aria-label={label} className="lang-toggle">
      {(['ko', 'en'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => choose(option)}
          aria-pressed={option === lang}
        >
          {option === 'ko' ? 'KO' : 'EN'}
        </button>
      ))}
    </div>
  );
}
