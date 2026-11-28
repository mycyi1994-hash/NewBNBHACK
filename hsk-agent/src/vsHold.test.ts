import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineKind, shownMoney, stakeOf, vsHold, won } from './vsHold.ts';

// The judges' case: the card showed "74만원 · 보유 66만원 · 보유보다 +9만원" (the raw difference was 8.6만원).
test('the badge is the difference of the two amounts on screen', () => {
  const r = { total: -0.2552, hold: -0.3412 };   // 744,800원 and 658,800원: 8.6만원 apart
  assert.equal(won('ko', stakeOf('ko') * (1 + r.total)), '74만원');
  assert.equal(won('ko', stakeOf('ko') * (1 + r.hold)), '66만원');
  const v = vsHold('ko', r);
  assert.equal(won('ko', Math.abs(v.diff)), '8만원');
  assert.equal(v.verdict, 'ahead');
  assert.equal(v.down, true, 'ahead of holding, but under what was put in');
});

test('for any pair of results, shown agent − shown holding = shown difference, in both languages', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const digits = (s: string) => Number(s.replace(/[^\d]/g, ''));
  for (let i = 0; i < 2000; i++) {
    const r = { total: rnd() * 3 - 0.95, hold: rnd() * 3 - 0.95 };
    for (const lang of ['ko', 'en'] as const) {
      const stake = stakeOf(lang), v = vsHold(lang, r);
      const mine = digits(won(lang, stake * (1 + r.total))), hold = digits(won(lang, stake * (1 + r.hold)));
      assert.equal(digits(won(lang, Math.abs(v.diff))), Math.abs(mine - hold), `${lang} ${JSON.stringify(r)}`);
      if (v.verdict === 'ahead') assert.ok(mine > hold);
      if (v.verdict === 'behind') assert.ok(mine < hold);
      assert.equal(v.down, shownMoney(lang, stake * (1 + r.total)) < stake);
    }
  }
});

test('within one point of holding, or the same amount on screen, reads as even', () => {
  assert.equal(vsHold('ko', { total: 0.104, hold: 0.096 }).verdict, 'even');   // 110만원 and 110만원
  assert.equal(vsHold('en', { total: 0.105, hold: 0.1 }).verdict, 'even');     // $5 apart: inside one point
  assert.equal(vsHold('en', { total: 0.2, hold: 0.1 }).verdict, 'ahead');
  assert.equal(vsHold('en', { total: 0.2, hold: 0.1 }).down, false);
});

test('the line over a list follows its badges', () => {
  const ahead = { verdict: 'ahead' as const, down: false }, less = { verdict: 'ahead' as const, down: true }, behind = { verdict: 'behind' as const, down: true };
  assert.equal(lineKind([]), 'nodata');
  assert.equal(lineKind([behind, behind]), 'none');
  assert.equal(lineKind([less, behind, behind]), 'some');
  assert.equal(lineKind([less, less, ahead, behind]), 'lost');
  assert.equal(lineKind([ahead, ahead, less]), 'won');
  // Half of the rows ahead are still down: the line says neither "lost less" nor "made more".
  assert.equal(lineKind([ahead, less, ahead, less]), 'better');
});

test('the line says the period on screen, then the whole record, with its real length', async () => {
  const { STRINGS } = await import('./i18n.ts');
  const ko = STRINGS.ko, en = STRINGS.en;
  assert.equal(ko.pfLine('lost', ko.pfLong[365], ko.pfSpan(3, 0), false, false), '1년은 대부분 보유보다 덜 잃었지만, 3년 내내 확실히 이긴 건 없었어요. 그래서 Moa 기본값으로 시작해요.');
  assert.equal(ko.pfLine('none', ko.pfLong[1095], ko.pfSpan(3, 0), true, false), '3년은 보유가 더 나았어요. 그래서 Moa 기본값으로 시작해요.');
  assert.equal(ko.pfLine('won', ko.pfLong[1095], ko.pfSpan(3, 0), true, false), '3년은 대부분 보유보다 더 벌었지만, 운일 수도 있어요. 그래서 Moa 기본값으로 시작해요.');
  // A coin with a short record (HSK): the line names the record's real length, never "3 years".
  const hsk = ko.pfLine('lost', ko.pfLong[365], ko.pfSpan(1, 10), false, true);
  assert.match(hsk, /기록이 1년 10개월뿐/);
  assert.doesNotMatch(hsk, /3년/);
  assert.match(ko.pfLine('nodata', ko.pfLong[1095], ko.pfSpan(1, 10), true, true), /^기록이 1년 10개월뿐이라 3년 결과는 아직 없어요\.$/);
  assert.equal(en.pfLine('lost', en.pfLong[365], en.pfSpan(3, 0), false, false), 'Over the last year most lost less than holding, but none clearly beat it over the full 3 years. So Moa starts you with its default.');
  assert.equal(en.pfSpan(1, 10), '1 year 10 months');
  // The owner says 금고 for the vault, everywhere in Korean.
  assert.doesNotMatch(JSON.stringify(ko, (_k, v) => (typeof v === 'function' ? String(v) : v)), /볼트/);
});
