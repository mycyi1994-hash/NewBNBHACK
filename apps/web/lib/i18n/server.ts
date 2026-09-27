/**
 * The viewer's language and time zone for server components. The web speaks English only
 * (DECISIONS D-26, a human decision): no language cookie, no Accept-Language. The time zone is
 * the one the browser reported (LocaleSync sets the cookie), else UTC.
 */
import { cookies } from 'next/headers';
import { makeT, type Lang, type T } from './translate';

export const TZ_COOKIE = 'yieldvest_tz';

function validZone(zone: string | undefined): zone is string {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export async function locale(): Promise<{ lang: Lang; tz: string; t: T }> {
  const lang: Lang = 'en';
  const zone = (await cookies()).get(TZ_COOKIE)?.value;
  return { lang, tz: validZone(zone) ? zone : 'UTC', t: makeT(lang) };
}
