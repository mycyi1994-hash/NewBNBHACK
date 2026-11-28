// How an agent did, said the same way everywhere (market card, list rows, chat card, detail):
//  - the hero is the agent's OWN result as money ("100만원 → 93만원"), with "그냥 보유 159만원" right under it;
//    never a difference between two returns as a headline;
//  - one period for the whole page (3달 / 1년 / 3년), chosen once and remembered;
//  - three marks for "did it beat just holding" over 3달, 1년, 3년: ▲ ahead, = about even (within 1 point), ▼ behind.
// The numbers come from each agent's own equity and holding curves; nothing is filled in. A period longer than the
// agent's record shows "—".
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Face } from './AgentCard.tsx';
import { markColor } from './Mark.tsx';
import { LIST_TIERS, byMerit, periodResult, tierOf, type Agent, type ListTier, type Period } from './agents.ts';
import { useT, type Strings } from './i18n.ts';

export type PeriodDays = 90 | 365 | 1095;
export const PERIODS: PeriodDays[] = [90, 365, 1095];
const DAY = 86_400;

/** One stretch of the record against holding: agents.ts keeps the one definition. */
export type PeriodResult = Period;
export { periodResult };

export type Verdict = 'ahead' | 'even' | 'behind';
export const verdictOf = (r: { total: number; hold: number }): Verdict => (r.total - r.hold > 0.01 ? 'ahead' : r.total - r.hold < -0.01 ? 'behind' : 'even');
export const VERDICT_MARK: Record<Verdict, string> = { ahead: '▲', even: '=', behind: '▼' };

/** The worst drop of a curve inside the last `days` (0..1). */
export function dropIn(pts: { time: number; value: number }[], days: number): number {
  if (!pts.length) return 0;
  const from = pts[pts.length - 1].time - days * DAY;
  let peak = 0, worst = 0;
  for (const p of pts) { if (p.time < from) continue; peak = Math.max(peak, p.value); if (peak > 0) worst = Math.max(worst, 1 - p.value / peak); }
  return worst;
}

/** The page's period: one for every card, remembered in this browser. */
export function usePeriod(): [PeriodDays, (p: PeriodDays) => void] {
  const [p, setP] = useState<PeriodDays>(() => { try { const v = Number(localStorage.getItem('moa.period')); return (PERIODS as number[]).includes(v) ? v as PeriodDays : 365; } catch { return 365; } });
  const pick = (v: PeriodDays) => { setP(v); try { localStorage.setItem('moa.period', String(v)); } catch { /* storage unavailable */ } };
  // Another list on screen changed it: follow.
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === 'moa.period' && (PERIODS as number[]).includes(Number(e.newValue))) setP(Number(e.newValue) as PeriodDays); };
    addEventListener('storage', on);
    return () => removeEventListener('storage', on);
  }, []);
  return [p, pick];
}

export function PeriodSwitch({ value, onChange }: { value: PeriodDays; onChange: (p: PeriodDays) => void }) {
  const { t } = useT();
  return (
    <div className="pf-switch" role="group" aria-label={t.pfPeriod}>
      {PERIODS.map((p) => <button key={p} className={value === p ? 'on' : ''} aria-pressed={value === p} onClick={() => onChange(p)}>{t.pfName[p]}</button>)}
    </div>
  );
}

/** What is put in, by language: 100만원, or $1,000. */
export const stakeOf = (lang: 'ko' | 'en') => (lang === 'ko' ? 1_000_000 : 1_000);
/** Money at card size: whole 만원 in Korean ("93만원"), whole dollars in English. */
export function won(lang: 'ko' | 'en', v: number): string {
  if (lang === 'en') return `$${Math.round(v).toLocaleString('en-US')}`;
  return v >= 1e8 ? `${(v / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}억원` : `${Math.round(v / 1e4).toLocaleString('ko-KR')}만원`;
}

/** "3달 ▲ · 1년 ▲ · 3년 ▼": did it beat just holding in each period. */
export function PeriodMarks({ a, active }: { a: Agent; active?: PeriodDays }) {
  const { t } = useT();
  return (
    <span className="pf-marks" aria-label={t.pfMarksLabel}>
      {PERIODS.map((p) => {
        const r = periodResult(a, p), v = r && verdictOf(r);
        return <span key={p} className={`pf-mark ${v ?? 'none'}${active === p ? ' on' : ''}`} data-tip={r ? t.pfMarkTip(t.pfName[p], t.pfVerdict[v!]) : t.pfNoData}>{t.pfName[p]}<i aria-hidden>{v ? VERDICT_MARK[v] : '–'}</i><span className="sr-only">{v ? t.pfVerdict[v] : t.pfNoData}</span></span>;
      })}
    </span>
  );
}

/** The hero: "1년 · 100만원 맡겼다면", the agent's money, then "그냥 보유 …". Same slot and size up or down. */
export function MoneyHero({ a, period, size = 'md' }: { a: Agent; period: PeriodDays; size?: 'md' | 'lg' | 'sm' }) {
  const { t, lang } = useT();
  const r = periodResult(a, period), stake = stakeOf(lang);
  if (!r) return <div className={`pf-hero ${size}`}><small>{t.pfIf(t.pfName[period], won(lang, stake))}</small><b className="pf-none">—</b><span className="pf-hold">{t.pfShort}</span></div>;
  const dir = r.total > 0.0005 ? 'up' : r.total < -0.0005 ? 'down' : 'flat';
  return (
    <div className={`pf-hero ${size}`}>
      <small>{t.pfIf(t.pfName[period], won(lang, stake))}</small>
      <b className={dir}>{won(lang, stake * (1 + r.total))}<i aria-hidden>{dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''}</i></b>
      <span className="pf-hold">{t.pfHold(won(lang, stake * (1 + r.hold)))}</span>
    </div>
  );
}

/** Just holding the coin, as a row in a list of agents: the benchmark every number in the list is read against. */
export function HoldRow({ coin, a, period }: { coin: string; a: Agent | undefined; period: PeriodDays }) {
  const { t, lang } = useT();
  const r = a && periodResult(a, period);
  return (
    <li className="pf-holdrow">
      <span className="pf-holdrow-name">{t.pfHoldName(coin)}</span>
      <span className="pf-holdrow-v">{r ? won(lang, stakeOf(lang) * (1 + r.hold)) : '—'}</span>
    </li>
  );
}

/* ---------- lists by tier, not rank ---------- */

export { LIST_TIERS };
export type { ListTier };
/** Folded by default: the classics, and the lab with its one-line warning. */
export const FOLDED: ReadonlySet<ListTier> = new Set<ListTier>(['classic', 'lab']);

/** Each agent's tier, from the one rule in agents.ts (`tierOf`). */
export function tiersOf(list: Agent[]): Map<string, ListTier> {
  return new Map(list.map((a) => [a.id, tierOf(a)]));
}

/** Group a list by tier, each group in Moa's own order. Empty groups are left out. */
export function byTier(list: Agent[]): { tier: ListTier; agents: Agent[] }[] {
  const tiers = tiersOf(list);
  return LIST_TIERS.map((tier) => ({ tier, agents: list.filter((a) => tiers.get(a.id) === tier).sort(byMerit) })).filter((g) => g.agents.length);
}

/** "5분 전 기준": when the list on screen was scored (the server's cache), said quietly. */
export function AsOf({ at, t }: { at?: number | null; t: Strings }) {
  if (!at) return null;
  return <span className="pf-asof">{t.listAsOf(Math.floor((Date.now() - at) / 60_000))}</span>;
}

/**
 * One agent as a list row: mark, name with a live dot, its one line, and ONE number (its own money for the period);
 * the list ends with just holding as a row, so the comparison is in the list itself. No rank. `pending` shows the
 * row before its number is worked out, with only the number shimmering.
 */
export function AgentRow({ a, period, onOpen, hire, pending }: { a: Pick<Agent, 'rule' | 'base' | 'made' | 'live' | 'kind'> & Partial<Agent>; period: PeriodDays; onOpen?: () => void; hire?: ReactNode; pending?: boolean }) {
  const { t, lang } = useT();
  const r = !pending && a.equity && a.bench ? periodResult(a as Agent, period) : undefined;
  const dir = r ? (r.total > 0.0005 ? 'up' : r.total < -0.0005 ? 'down' : 'flat') : '';
  return (
    <li className="ar-row" style={{ '--fam': markColor(a.rule) } as CSSProperties}>
      <button className="ar-open" onClick={onOpen} disabled={!onOpen}>
        <Face rule={a.rule} base={a.base} size="md" />
        <span className="ar-main">
          <b>{a.made?.name ?? `${a.base} ${t.agNick[a.rule]}`}{a.live && a.kind === 'position' && <i className="ar-live" aria-label={t.frHolding} />}</b>
          <small>{a.made ? '' : t.agPlain[a.rule]}</small>
        </span>
        <span className={`ar-num ${dir}`}>{pending ? <span className="skel ar-skel" /> : r ? <>{won(lang, stakeOf(lang) * (1 + r.total))}<i aria-hidden>{dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''}</i></> : '—'}</span>
      </button>
      {hire}
    </li>
  );
}
