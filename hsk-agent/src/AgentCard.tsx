// One agent card in three sizes, so an agent looks and reads the same everywhere:
//  - tile: under the chart (tap → Moa explains it)
//  - market: the agent market grid (Hire · Ask Moa)
//  - chat: inside Moa's conversation (numbers, equity, rules; actions come from the conversation)
import type { ReactNode } from 'react';
import type { Agent, RuleId } from './agents.ts';
import { useT, type Strings } from './i18n.ts';
import { RollNum } from './motion.tsx';
import { CoinMark } from './CoinMark.tsx';

export const pct = (v: number, d = 1) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
export const drop = (v: number) => `−${(v * 100).toFixed(1)}%`;
export const multText = (m: number) => String(Math.round(m * 100) / 100);
export const agentName = (t: Strings, a: { base: string; rule: RuleId }) => `${a.base} ${t.agRule[a.rule]}`;

export function statePill(t: Strings, a: Agent): { text: string; cls: string } {
  if (a.kind === 'position') return a.live ? { text: t.acHolding, cls: 'sig-good' } : { text: t.acWaiting, cls: 'sig-neutral' };
  return a.mult > 0 ? { text: t.acToday(multText(a.mult)), cls: a.mult > 1 ? 'sig-good' : 'sig-neutral' } : { text: t.acRest, cls: 'sig-wait' };
}
export const nowLine = (t: Strings, a: Agent) => (a.kind === 'position' ? (a.live ? t.acNowHolding : t.acNowWaiting) : a.mult > 0 ? t.acNowBuy(multText(a.mult)) : t.acNowRest);
export const sourceLine = (t: Strings, a: Agent) => (a.kind === 'collect' ? t.acSrcCollect : a.runnable ? t.acSrcPos : t.acSrcSignal(a.market?.kind === 'perp'));
export const explainAgent = (t: Strings, a: Agent) => t.acExplain(agentName(t, a), pct(a.total), pct(a.hold), drop(a.maxDd), nowLine(t, a));

/** Small equity curve. */
export function Equity({ pts, up, wide }: { pts: { value: number }[]; up: boolean; wide?: boolean }) {
  const W = wide ? 320 : 160, H = wide ? 72 : 56;
  if (pts.length < 2) return null;
  const xs = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 120)) === 0 || i === pts.length - 1);
  const lo = Math.min(...xs.map((p) => p.value)), hi = Math.max(...xs.map((p) => p.value)), span = hi - lo || 1;
  const d = xs.map((p, i) => `${i ? 'L' : 'M'}${((i / (xs.length - 1)) * W).toFixed(1)},${(H - 3 - ((p.value - lo) / span) * (H - 6)).toFixed(1)}`).join('');
  const color = up ? '#16a34a' : '#dc2626';
  return (
    <svg className={wide ? 'ag-eq wide' : 'ag-eq'} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={`${d}L${W},${H}L0,${H}Z`} fill={color} opacity=".1" />
      <path className="draw" pathLength={1} d={d} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const ICON: Record<RuleId, string> = {
  trend: 'M3 15l5-5 3 3 6-7', ema: 'M3 14c4 0 5-7 9-7 2 0 3 1 5 1M3 10c4 0 6 4 9 4 2 0 3-2 5-3',
  break: 'M3 13h5l2-6 2 9 2-5h3', rsi: 'M3 6h14M3 14h14M4 12l3-5 3 7 3-6 3 4', boll: 'M3 5c5 3 9 3 14 0M3 15c5-3 9-3 14 0M3 10h14',
  daily: 'M4 16h3v-3h3v-3h3V7h3', smart: 'M3 7c3 0 4 7 7 7s4-7 7-7M6 16h8', trendDca: 'M3 13l4-4 3 2 7-6M3 17h14', rsiDca: 'M4 16V9M8 16V5M12 16v-4M16 16V8',
};
export function RuleIcon({ rule }: { rule: RuleId }) {
  return <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden><path d={ICON[rule]} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const signCls = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

export function AgentCard({ agent: a, size, picked, best, onPick, onHire, onAsk, starred, onStar, actions }: {
  agent: Agent; size: 'tile' | 'market' | 'chat'; picked?: boolean; best?: boolean;
  onPick?: () => void; onHire?: () => void; onAsk?: () => void; starred?: boolean; onStar?: () => void; actions?: ReactNode;
}) {
  const { t } = useT();
  const pill = statePill(t, a);

  if (size === 'tile') {
    return (
      <button className={`tile${picked ? ' on' : ''}`} onClick={onPick} aria-pressed={picked}>
        <span className="tile-top">
          <b>{t.agRule[a.rule]}</b>
          <span className={`sig ${pill.cls}`}>{pill.text}</span>
        </span>
        <span className="tile-line">{t.agLine[a.rule]}</span>
        <span className="tile-num">
          <RollNum flash={false} className={`tile-val ${signCls(a.total)}`} text={pct(a.total)} />
          <small>{t.acDays(a.days)} · {t.acHold} {pct(a.hold)} · {t.acDd} {drop(a.maxDd)}</small>
        </span>
        {best && <span className="tile-best">{t.stratRec}</span>}
      </button>
    );
  }

  const head = (
    <header className="ag-card-head">
      <span className={`ag-avatar ag-r-${a.rule}`} aria-hidden><RuleIcon rule={a.rule} /></span>
      <div className="ag-card-title">
        <b>{agentName(t, a)}</b>
        <span className="ag-meta"><CoinMark base={a.base} />{sourceLine(t, a)}</span>
      </div>
      <span className={`sig ${pill.cls}`}>{pill.text}</span>
    </header>
  );

  if (size === 'chat') {
    return (
      <div className="acard">
        {head}
        <p className="ag-line">{t.agLine[a.rule]}</p>
        <dl className="acard-nums">
          <div><dt>{t.acTotal}</dt><dd className={signCls(a.total)}>{pct(a.total)}</dd></div>
          <div><dt>{t.acHold}</dt><dd className={signCls(a.hold)}>{pct(a.hold)}</dd></div>
          <div><dt>{t.acDd}</dt><dd>{drop(a.maxDd)}</dd></div>
        </dl>
        <Equity pts={a.equity} up={a.total >= 0} wide />
        <div className="scard-rules">
          <b>{t.acRules}</b>
          <ul>{t.agRules[a.rule].map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
        {!a.runnable && <p className="acard-demo">{t.whyNot(a.base)}</p>}
        <p className="acard-foot">{t.acFoot(`${(a.fee * 100).toFixed(1)}%`, a.days)}</p>
        {actions}
      </div>
    );
  }

  return (
    <article className={`ag-card${a.runnable ? '' : ' signal-only'}`}>
      {head}
      <p className="ag-line">{t.agLine[a.rule]}</p>
      <div className="ag-main">
        <div>
          <small>{t.acTotal} · {t.acDays(a.days)}</small>
          <RollNum flash={false} className={`ag-big ${signCls(a.total)}`} text={pct(a.total)} />
        </div>
        <Equity pts={a.equity} up={a.total >= 0} />
      </div>
      <dl className="ag-metrics">
        <div><dt>{t.acHold}</dt><dd className={signCls(a.hold)}>{pct(a.hold)}</dd></div>
        <div><dt>{t.acDd}</dt><dd>{drop(a.maxDd)}</dd></div>
        <div><dt>{t.agSharpe}</dt><dd>{a.sharpe.toFixed(2)}</dd></div>
        <div><dt>{a.kind === 'collect' ? t.acBuys : t.agTrades}</dt><dd>{a.trades}</dd></div>
        <div><dt>{t.acFee}</dt><dd>{(a.fee * 100).toFixed(1)}%</dd></div>
        <div><dt>{t.agDays}</dt><dd>{a.days}{t.agDayUnit}</dd></div>
      </dl>
      <footer className="ag-card-foot">
        {onStar && (
          <button className={`ag-star${starred ? ' on' : ''}`} onClick={onStar} aria-pressed={starred} aria-label={t.agStar} data-tip={t.agStar}>
            <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden><path d="M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2L2.5 8l5.2-.7L10 2.5z" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
          </button>
        )}
        {a.runnable
          ? <button className="btn-primary ag-use" onClick={onHire}>{t.acHire}</button>
          : <span className="ag-signal-badge">{t.acSignal}</span>}
        <button className="btn-ghost ag-ask" onClick={onAsk}>{t.acAsk}</button>
      </footer>
    </article>
  );
}
