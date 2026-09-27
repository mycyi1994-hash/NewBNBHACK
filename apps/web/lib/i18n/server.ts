/**
 * The viewer's language and time zone for server components (M2-05): the language cookie, else
 * the browser's language (Korean → ko, anything else → en, DESIGN_BRIEF §0); the zone the browser
 * reported (LocaleSync sets the cookie), else Seoul for Korean and UTC otherwise.
 */
import { cookies, headers } from 'next/headers';
import { makeT, type Lang, type T } from './translate';

export const LANG_COOKIE = 'yieldvest_lang';
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
  const jar = await cookies();
  const chosen = jar.get(LANG_COOKIE)?.value;
  let lang: Lang;
  if (chosen === 'ko' || chosen === 'en') lang = chosen;
  else {
    const accept = (await headers()).get('accept-language') ?? '';
    lang = /^\s*ko\b/i.test(accept) ? 'ko' : 'en';
  }
  const zone = jar.get(TZ_COOKIE)?.value;
  const tz = validZone(zone) ? zone : lang === 'ko' ? 'Asia/Seoul' : 'UTC';
  return { lang, tz, t: makeT(lang) };
}
