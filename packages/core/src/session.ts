/**
 * US equity session from our own clock (SPEC §10 tape tags). The RWA API's statusInfo is the
 * authority for trading decisions (SPEC §5.2); this tag exists so the tape can compare the two.
 * Times are America/New_York, so DST is handled by the platform's time-zone data.
 */

export type UsSession = 'regular' | 'pre' | 'post' | 'overnight' | 'weekend' | 'holiday';

/** NYSE full-day closures, 2026 (nyse.com holidays page). Extend yearly. */
const NYSE_HOLIDAYS = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

/** NYSE 13:00 ET early closes, 2026. */
const NYSE_EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24']);

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

export function newYorkParts(at: Date): { date: string; weekday: string; minutes: number } {
  const parts = Object.fromEntries(ET.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday ?? '',
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function usSession(at: Date): UsSession {
  const { date, weekday, minutes } = newYorkParts(at);
  if (weekday === 'Sat' || weekday === 'Sun') return 'weekend';
  if (NYSE_HOLIDAYS.has(date)) return 'holiday';
  const close = NYSE_EARLY_CLOSE.has(date) ? 13 * 60 : 16 * 60;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'pre';
  if (minutes >= 9 * 60 + 30 && minutes < close) return 'regular';
  if (minutes >= close && minutes < 20 * 60) return 'post';
  return 'overnight';
}
