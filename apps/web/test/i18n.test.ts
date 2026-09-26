/**
 * UI strings and formatting (M2-04/M2-05): the dictionaries come from docs/UX_COPY.md and match
 * the generated file; KR and EN name the same placeholders; missing values drop their sentence
 * instead of showing a half-filled one; numbers are never rounded up or invented.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  displayParams,
  money,
  money6,
  sharesText,
  signedPct,
  bpsPct,
  timeText,
} from '../lib/format';
import { COPY } from '../lib/i18n/copy';
import { translate } from '../lib/i18n/translate';
import { parseUxCopy, placeholders } from '../lib/i18n/ux-copy';
import { lintCopy, render } from '../scripts/copy';

const DOC = readFileSync(
  path.join(import.meta.dirname, '..', '..', '..', 'docs', 'UX_COPY.md'),
  'utf8',
);

describe('UX_COPY → dictionaries', () => {
  const copy = parseUxCopy(DOC);

  it('is what copy.ts holds (pnpm copy:gen is up to date)', async () => {
    const generated = await render(copy);
    const current = readFileSync(
      path.join(import.meta.dirname, '..', 'lib', 'i18n', 'copy.ts'),
      'utf8',
    );
    expect(current).toBe(generated);
    expect(COPY.ko).toEqual(copy.ko);
    expect(COPY.en).toEqual(copy.en);
  });

  it('reads every section: screens, reasons, the risk text and the banned words', () => {
    expect(copy.ko['home.title']).toBe('이자로 주식을 삽니다');
    expect(copy.en['judge.run.progress.swap']).toBe('Buying…');
    expect(copy.ko['why.skipped.daily_cap']).toBe('오늘 한도(${daily})를 다 썼어요. 내일 다시요.');
    expect(copy.en['risk.cta']).toBe('Agree and turn on');
    expect(
      Object.keys(copy.ko).filter((k) => k.startsWith('risk.') && /^risk\.\d$/.test(k)),
    ).toHaveLength(5);
    expect(copy.banned).toContain('guaranteed');
    expect(copy.banned).toContain('추천 종목');
  });

  it('has the same keys and placeholders in Korean and English, and no banned word anywhere', () => {
    expect(Object.keys(copy.en)).toEqual(Object.keys(copy.ko));
    for (const key of Object.keys(copy.ko)) {
      expect(placeholders(copy.en[key] ?? ''), key).toEqual(placeholders(copy.ko[key] ?? ''));
    }
    expect(lintCopy(copy)).toEqual([]);
  });

  it('fails loudly on a line it cannot read', () => {
    const broken = DOC.replace('- `nav.home`: 홈 / Home', '- `nav.home`: 홈 Home');
    expect(() => parseUxCopy(broken)).toThrow(/nav.home must read "KR \/ EN"/);
    const duplicate = DOC.replace('- `nav.dx`: 기록·데이터 / Data', '- `nav.home`: 홈 / Home');
    expect(() => parseUxCopy(duplicate)).toThrow(/duplicate key nav.home/);
  });
});

describe('translate', () => {
  it('fills placeholders, keeping the literal $ of the copy', () => {
    expect(translate('en', 'judge.code.hint', { cap: '5.00' })).toBe(
      "One code covers up to $5.00. Funds come from Ijaro's own wallet.",
    );
  });

  it('leaves out a sentence whose value is missing (no US price → no gap sentence)', () => {
    const params = { ticker: 'NVDA', shares: '0.022194', usd: '5.00' };
    expect(translate('ko', 'why.bought.regular', params)).toBe(
      '정규장에 NVDA 0.022194주($5.00)를 샀어요.',
    );
    expect(translate('ko', 'why.bought.regular', { ...params, gap: '+0.30' })).toBe(
      '정규장에 NVDA 0.022194주($5.00)를 샀어요. 기준 주가 대비 +0.30%.',
    );
    // The preview line has no fee estimate: that sentence is dropped, never guessed.
    expect(
      translate('en', 'judge.preview.line', { usd: '5.00', ticker: 'NVDA', shares: '0.0222' }),
    ).toBe('You pay $5.00 and receive about 0.0222 shares of NVDA.');
  });
});

describe('format', () => {
  it('truncates money to the cent and interest to six places, never rounding up', () => {
    expect(money('5')).toBe('5.00');
    expect(money('2.999')).toBe('2.99');
    expect(money('abc')).toBeNull();
    expect(money(null)).toBeNull();
    expect(money6('0.1842139')).toBe('0.184213');
    expect(money6('-0.5')).toBe('-0.500000');
    expect(money('-1.239')).toBe('-1.23');
    expect(sharesText('0.022194882471391432')).toBe('0.022194');
  });

  it('signs percentages with a real minus, never "-0.00"', () => {
    expect(signedPct('0.3')).toBe('+0.30');
    expect(signedPct(-0.354)).toBe('−0.35');
    expect(signedPct('-0.00004')).toBe('0.00');
    expect(signedPct(null)).toBeNull();
    expect(bpsPct(316)).toBe('3.16');
    expect(bpsPct(null)).toBeNull();
  });

  it('shows engine times in the viewer’s zone and signs the gap', () => {
    const params = displayParams(
      { open: '2026-09-28T13:32:00.000Z', gap: '-0.35', ticker: 'NVDA' },
      'ko',
      'Asia/Seoul',
    );
    expect(params.open).toBe(timeText('2026-09-28T13:32:00.000Z', 'ko', 'Asia/Seoul'));
    expect(params.open).toContain('22:32');
    expect(params.gap).toBe('−0.35');
    expect(params.ticker).toBe('NVDA');
    expect(timeText('2026-09-28T13:32:00.000Z', 'en', 'America/New_York')).toContain('09:32');
  });
});
