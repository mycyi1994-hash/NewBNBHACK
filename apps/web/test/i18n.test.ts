/**
 * UI strings and formatting (M2-04/M2-05): the English dictionary comes from docs/UX_COPY.md and
 * matches the generated file; the copy is English only (DECISIONS D-26, D-27); missing values drop
 * their sentence instead of showing a half-filled one; numbers are never rounded up or invented.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  displayParams,
  fromBaseUnits,
  grouped,
  issuerName,
  money,
  money6,
  moneyFine,
  sharesText,
  signedPct,
  bpsPct,
  timeText,
} from '../lib/format';
import { COPY } from '../lib/i18n/copy';
import { makeT, translate } from '../lib/i18n/translate';
import { pausedText } from '../components/plan-text';
import { parseUxCopy } from '../lib/i18n/ux-copy';
import { lintCopy, render } from '../scripts/copy';

const DOC = readFileSync(
  path.join(import.meta.dirname, '..', '..', '..', 'docs', 'UX_COPY.md'),
  'utf8',
);

describe('UX_COPY → dictionary', () => {
  const copy = parseUxCopy(DOC);

  it('is what copy.ts holds (pnpm copy:gen is up to date)', async () => {
    const generated = await render(copy);
    const current = readFileSync(
      path.join(import.meta.dirname, '..', 'lib', 'i18n', 'copy.ts'),
      'utf8',
    );
    expect(current).toBe(generated);
    expect(COPY.en).toEqual(copy.en);
  });

  it('reads every section: screens, reasons, the risk text and the banned words', () => {
    expect(copy.en['home.title']).toBe('Interest buys the stock.');
    expect(copy.en['judge.run.progress.swap']).toBe('Buying…');
    expect(copy.en['why.skipped.daily_cap']).toBe('Daily limit (${daily}) reached. Tomorrow.');
    expect(copy.en['risk.intro']).toMatch(/^Yieldvest is not a bank\./);
    expect(copy.en['risk.cta']).toBe('Agree and turn on');
    expect(Object.keys(copy.en).filter((k) => /^risk\.\d$/.test(k))).toHaveLength(5);
    expect(copy.banned).toContain('guaranteed');
    expect(copy.banned).toContain('recommended stock');
  });

  it('is English only, with no banned word in the copy, the web source or the skill', () => {
    const hangul = /\p{Script=Hangul}/u;
    expect(Object.keys(copy.en).filter((key) => hangul.test(copy.en[key] ?? ''))).toEqual([]);
    expect(lintCopy(copy)).toEqual([]);
  });

  it('fails loudly on a line it cannot read', () => {
    const line = '- `nav.home`: Home';
    const hangul = String.fromCodePoint(0xd648);
    expect(() => parseUxCopy(DOC.replace(line, `- \`nav.home\`: ${hangul}`))).toThrow(
      'nav.home is not English',
    );
    expect(() => parseUxCopy(DOC.replace(line, '- `nav.home`: '))).toThrow('nav.home has no text');
    expect(() => parseUxCopy(DOC.replace('- `nav.dx`: Data', line))).toThrow(
      'duplicate key nav.home',
    );
    expect(() =>
      parseUxCopy(DOC.replace('Allowing… / Buying… / Confirming…', 'Allowing… / Buying…')),
    ).toThrow('judge.run.progress.{approve|swap|confirm} needs 3 variants');
  });
});

describe('translate', () => {
  it('fills placeholders, keeping the literal $ of the copy', () => {
    expect(translate('en', 'judge.code.hint', { cap: '5.00' })).toBe(
      'Each invite covers up to $5.00 of purchases on BNB Chain, paid for and held by Yieldvest. You choose, and you can follow every step and receipt.',
    );
  });

  it('leaves out a sentence whose value is missing (no US price → no gap sentence)', () => {
    const params = { ticker: 'NVDA', shares: '0.022194', usd: '5.00' };
    expect(translate('en', 'why.bought.regular', params)).toBe(
      'Bought 0.022194 shares of NVDA ($5.00) during regular hours.',
    );
    expect(translate('en', 'why.bought.regular', { ...params, gap: '+0.30' })).toBe(
      'Bought 0.022194 shares of NVDA ($5.00) during regular hours. +0.30% vs reference.',
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

  it('shows interest to the micro-dollar without trailing zeros, and groups thousands', () => {
    expect(moneyFine('0.46')).toBe('0.46');
    expect(moneyFine('0.1842139')).toBe('0.184213');
    expect(moneyFine('5')).toBe('5.00');
    expect(moneyFine('0.1')).toBe('0.10');
    expect(moneyFine('12.3456')).toBe('12.3456');
    expect(moneyFine(null)).toBeNull();
    expect(grouped('1000.00')).toBe('1,000.00');
    expect(grouped('185541887')).toBe('185,541,887');
    expect(grouped('-1234.5')).toBe('-1,234.5');
    expect(grouped('999.99')).toBe('999.99');
    expect(grouped(null)).toBeNull();
  });

  it('reads 18-decimal base units exactly, and names issuers as they name themselves', () => {
    expect(fromBaseUnits('1500000000000000000')).toBe('1.5');
    expect(fromBaseUnits('280000000000000000')).toBe('0.28');
    expect(fromBaseUnits('5000000000000000000')).toBe('5');
    expect(fromBaseUnits('1')).toBe('0.000000000000000001');
    expect(fromBaseUnits('-5')).toBeNull();
    expect(fromBaseUnits('')).toBeNull();
    expect(issuerName('NVDA:bstocks')).toBe('bStocks');
    expect(issuerName('ondo')).toBe('Ondo');
    expect(issuerName('XYZ:other')).toBe('other');
    expect(issuerName(null)).toBeNull();
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
      'en',
      'Asia/Seoul',
    );
    expect(params.open).toBe(timeText('2026-09-28T13:32:00.000Z', 'en', 'Asia/Seoul'));
    expect(params.open).toContain('22:32');
    expect(params.gap).toBe('−0.35');
    expect(params.ticker).toBe('NVDA');
    expect(timeText('2026-09-28T13:32:00.000Z', 'en', 'America/New_York')).toContain('09:32');
  });
});

describe('why a plan is paused or stopped', () => {
  const t = makeT('en');
  // Every reason the worker and the web write (pausedReason in apps/agent, apps/web, packages/db).
  const REASONS = [
    'awaiting_funding',
    'awaiting_run',
    'awaiting_deposit',
    'report_over_limit',
    'expired',
    'stopped_by_owner',
    'done',
    'code_disabled',
    'needs_review',
    'redeemed',
    'operator_redeem',
    'paused_by_operator',
    'guardian:tvl_drop',
  ];

  it('has words of its own for each one: no code on the screen, no "Paused" for a stopped plan', () => {
    for (const reason of REASONS) {
      const text = pausedText(t, reason) ?? '';
      expect(text, reason).not.toBe('');
      expect(text, reason).not.toContain(reason);
      expect(text, reason).not.toMatch(/_/);
    }
    expect(pausedText(t, 'stopped_by_owner')).toBe('Stopped by its owner');
    expect(pausedText(t, null)).toBeNull();
    // An operator's own words (plan:status --reason) are shown as given.
    expect(pausedText(t, 'bank holiday check')).toBe('Paused: bank holiday check');
  });

  it('says when a stop or pause stands but its redeem did not complete', () => {
    expect(pausedText(t, 'stopped_by_owner:redeem_pending')).toBe(
      'Stopped by its owner. Its principal is still in the interest account; the Yieldvest team has been alerted.',
    );
    expect(pausedText(t, 'guardian:tvl_drop:redeem_not_live')).toMatch(
      /^Paused by the guardian\. Its principal is still in the interest account/,
    );
    expect(pausedText(t, 'expired:redeem_failed')).toMatch(/^Ended after 7 days\. /);
  });
});
