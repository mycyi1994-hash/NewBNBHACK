/**
 * Copy lookup for server and client components. A sentence whose placeholder has no value is left
 * out rather than shown half-filled: `why.bought.*` without a US price drops "{gap}% vs
 * reference." (DESIGN_BRIEF §5.1), and the preview line drops the fee we do not estimate. The UI
 * is English only (DECISIONS D-26); `Lang` stays the one seam a second language would need.
 */
import { COPY, type CopyKey } from './copy';

export type Lang = 'en';
export type Params = Readonly<Record<string, string | number | null | undefined>>;
export type { CopyKey };

export function isCopyKey(key: string): key is CopyKey {
  return Object.hasOwn(COPY.en, key);
}

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

export function translate(lang: Lang, key: CopyKey, params: Params = {}): string {
  const template: string = COPY[lang][key];
  const filled = (text: string) =>
    [...text.matchAll(PLACEHOLDER)].every((m) => {
      const value = params[m[1] ?? ''];
      return value !== undefined && value !== null && value !== '';
    });
  const sentences = template.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(filled);
  return (kept.length > 0 ? kept : sentences)
    .join(' ')
    .replace(PLACEHOLDER, (whole, name: string) => {
      const value = params[name];
      return value === undefined || value === null ? whole : String(value);
    });
}

export type T = (key: CopyKey, params?: Params) => string;

export const makeT =
  (lang: Lang): T =>
  (key, params) =>
    translate(lang, key, params);
