// An agent against just holding, as a card says it. Pure: no React, so the arithmetic is tested on its own.
// The badge is the difference of the two rounded amounts on screen, so "74만원 · 보유 66만원" reads "8만원".

export type Verdict = 'ahead' | 'even' | 'behind';
/** Ahead or behind by more than one point of what was put in; inside that, about even. */
export const verdictOf = (r: { total: number; hold: number }): Verdict => (r.total - r.hold > 0.01 ? 'ahead' : r.total - r.hold < -0.01 ? 'behind' : 'even');

type Lang = 'ko' | 'en';
/** What is put in, by language: 100만원, or $1,000. */
export const stakeOf = (lang: Lang) => (lang === 'ko' ? 1_000_000 : 1_000);
/** A money amount as a card rounds it: whole 만원 in Korean (0.01억 from 1억), whole dollars in English. */
export const shownMoney = (lang: Lang, v: number) => (lang === 'en' ? Math.round(v) : v >= 1e8 ? Math.round(v / 1e6) * 1e6 : Math.round(v / 1e4) * 1e4);
/** Money at card size: whole 만원 in Korean ("93만원"), whole dollars in English. */
export function won(lang: Lang, v: number): string {
  if (lang === 'en') return `$${Math.round(v).toLocaleString('en-US')}`;
  return v >= 1e8 ? `${(v / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}억원` : `${Math.round(v / 1e4).toLocaleString('ko-KR')}만원`;
}

export interface VsHold {
  verdict: Verdict;
  /** The agent's shown amount minus holding's shown amount. */
  diff: number;
  /** The agent ended under what was put in. */
  down: boolean;
}
/** The agent against holding for one period, from the two amounts the card shows. */
export function vsHold(lang: Lang, r: { total: number; hold: number }): VsHold {
  const stake = stakeOf(lang), mine = shownMoney(lang, stake * (1 + r.total)), diff = mine - shownMoney(lang, stake * (1 + r.hold));
  return { verdict: diff === 0 || verdictOf(r) === 'even' ? 'even' : diff > 0 ? 'ahead' : 'behind', diff, down: mine < stake };
}

/**
 * What the badges of a list say together, for the one line over it. Most rows ahead of holding: 'lost' when at
 * least two in three of those are still down (grey badges), 'won' when at most one in three is, 'better' in
 * between. Otherwise a few ahead ('some'), none ('none'), or no result for the period ('nodata').
 */
export type LineKind = 'lost' | 'won' | 'better' | 'some' | 'none' | 'nodata';
export function lineKind(rows: Pick<VsHold, 'verdict' | 'down'>[]): LineKind {
  const ahead = rows.filter((v) => v.verdict === 'ahead');
  if (!rows.length) return 'nodata';
  if (!ahead.length) return 'none';
  if (ahead.length * 2 <= rows.length) return 'some';
  const down = ahead.filter((v) => v.down).length;
  return down * 3 >= ahead.length * 2 ? 'lost' : down * 3 <= ahead.length ? 'won' : 'better';
}
