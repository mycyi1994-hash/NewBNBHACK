/**
 * Display formatting (DESIGN_BRIEF §2): money to the cent and never rounded up, shares to six
 * decimals, signed percentages with a real minus sign, times in the viewer's zone. Inputs are the
 * decimal strings the API and database use; nothing here invents a value — missing stays missing.
 */
import { formatShares, formatUsd, toUnits } from '@yieldvest/core';
import type { Lang } from './i18n/translate';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const MINUS = '−';

/** A decimal string as 18-decimal units (extra decimals truncated); null when it is not a number. */
function units(value: string): bigint | null {
  if (!DECIMAL.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? value.slice(1) : value).split('.');
  const abs = toUnits(`${whole}${frac ? `.${frac.slice(0, 18)}` : ''}`, 18);
  return negative ? -abs : abs;
}

/** "5" → "5.00"; truncated to the cent; null when there is no number. */
export function money(value: string | null | undefined): string | null {
  const u = value === null || value === undefined ? null : units(value);
  return u === null ? null : formatUsd(u);
}

/** Six decimals, truncated — for interest that grows by fractions of a cent. */
export function money6(value: string | null | undefined): string | null {
  const u = value === null || value === undefined ? null : units(value);
  if (u === null) return null;
  const negative = u < 0n;
  const abs = negative ? -u : u;
  const micro = abs / 10n ** 12n;
  const text = `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`;
  return negative ? `-${text}` : text;
}

/** Thousands separators for a decimal string: "1000.00" → "1,000.00" (display only). */
export function grouped(text: string | null): string | null {
  if (text === null) return null;
  const [whole = '', frac] = text.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${withCommas}${frac === undefined ? '' : `.${frac}`}`;
}

/**
 * Interest to the micro-dollar without trailing zeros, never fewer than two places: "0.46" stays
 * "0.46", "0.184213" stays as read. Truncated like money6, so a small amount is never rounded up.
 */
export function moneyFine(value: string | null | undefined): string | null {
  const text = money6(value);
  return text === null ? null : text.replace(/(\.\d\d\d*?)0+$/, '$1');
}

/** A whole number of 18-decimal base units ("1500000000000000000") as a decimal string ("1.5"). */
export function fromBaseUnits(value: string | null | undefined): string | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const units = BigInt(value);
  const whole = units / 10n ** 18n;
  const frac = (units % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

export function sharesText(value: string | null | undefined): string | null {
  const u = value === null || value === undefined ? null : units(value);
  return u === null ? null : formatShares(u);
}

/** "0.3" → "+0.30", "-0.35" → "−0.35", "0" → "0.00". */
export function signedPct(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const text = Math.abs(n).toFixed(2);
  if (text === '0.00') return text;
  return `${n < 0 ? MINUS : '+'}${text}`;
}

/** Basis points → percent with two decimals ("316" → "3.16"). */
export function bpsPct(bps: number | string | null | undefined): string | null {
  const n = Number(bps);
  return bps === null || bps === undefined || !Number.isFinite(n) ? null : (n / 100).toFixed(2);
}

const LOCALES: Readonly<Record<Lang, string>> = { en: 'en-US' };

export function timeText(iso: string | null | undefined, lang: Lang, tz: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat(LOCALES[lang], {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/** Whole minutes between an ISO time and now (never negative). */
export function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Engine and API params → display strings: ISO times in the viewer's zone, `gap` signed, dollar
 * amounts to the cent; everything else as given.
 */
export function displayParams(
  params: Readonly<Record<string, unknown>> | null | undefined,
  lang: Lang,
  tz: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(params ?? {})) {
    if (raw === null || raw === undefined) continue;
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (ISO.test(value)) out[name] = timeText(value, lang, tz) ?? value;
    else if (name === 'gap') out[name] = signedPct(value) ?? value;
    else out[name] = value;
  }
  return out;
}

/** An issuer id ("bstocks", or an instrument id "NVDA:bstocks") as the issuer calls itself. */
export function issuerName(id: string | null | undefined): string | null {
  if (!id) return null;
  const issuer = id.includes(':') ? (id.split(':')[1] ?? '') : id;
  return issuer === 'bstocks' ? 'bStocks' : issuer === 'ondo' ? 'Ondo' : issuer || null;
}

/** A 0x… address shortened for "Details" views. */
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
