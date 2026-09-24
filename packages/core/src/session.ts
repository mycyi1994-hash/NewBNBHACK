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

/** 09:30 New York time, in minutes after midnight. */
const REGULAR_OPEN_MINUTES = 9 * 60 + 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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
    weekday: String(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function usSession(at: Date): UsSession {
  const { date, weekday, minutes } = newYorkParts(at);
  if (weekday === 'Sat' || weekday === 'Sun') return 'weekend';
  if (NYSE_HOLIDAYS.has(date)) return 'holiday';
  const close = NYSE_EARLY_CLOSE.has(date) ? 13 * 60 : 16 * 60;
  if (minutes >= 4 * 60 && minutes < REGULAR_OPEN_MINUTES) return 'pre';
  if (minutes >= REGULAR_OPEN_MINUTES && minutes < close) return 'regular';
  if (minutes >= close && minutes < 20 * 60) return 'post';
  return 'overnight';
}

/** The UTC instant of `minutes` after midnight, New York time, on New York date `ymd`. */
export function newYorkTimeOn(ymd: string, minutes: number): Date {
  const [y = NaN, m = NaN, d = NaN] = ymd.split('-').map(Number);
  // New York is UTC−4 (EDT) or UTC−5 (EST); exactly one of the two lands on the wanted wall time.
  for (const offsetMinutes of [4 * 60, 5 * 60]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, 0, minutes + offsetMinutes));
    const parts = newYorkParts(candidate);
    if (parts.date === ymd && parts.minutes === minutes) return candidate;
  }
  throw new Error(`no New York wall time ${minutes} min on ${ymd}`);
}

/**
 * Start of the next NYSE regular session strictly after `now` (09:30 ET on the next day that is
 * neither a weekend nor a full-day holiday). The decision engine gates on this calendar, not on
 * the RWA status: bStocks report `TRADING` overnight (dx/LOG.md 2026-09-24 00:45).
 */
export function nextRegularOpen(now: Date, searchDays = 14): Date {
  const today = newYorkParts(now).date;
  // Step from noon to noon so a 23- or 25-hour DST day never skips or repeats a date.
  let noon = newYorkTimeOn(today, 12 * 60);
  for (let i = 0; i < searchDays; i++) {
    const { date, weekday } = newYorkParts(noon);
    if (weekday !== 'Sat' && weekday !== 'Sun' && !NYSE_HOLIDAYS.has(date)) {
      const open = newYorkTimeOn(date, REGULAR_OPEN_MINUTES);
      if (open.getTime() > now.getTime()) return open;
    }
    noon = new Date(noon.getTime() + DAY_MS);
  }
  throw new Error(`no NYSE session within ${searchDays} days of ${now.toISOString()}`);
}
