// One agent card in three sizes, so an agent looks and reads the same everywhere:
//  - tile: under the chart (tap → Moa explains it)
//  - market: the agent market grid (Hire · Ask Moa)
//  - chat: inside Moa's conversation (numbers, equity, rules; actions come from the conversation)
import type { ReactNode } from 'react';
import type { Agent, RuleId } from './agents.ts';
import { useT, type Strings } from './i18n.ts';
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


export function AgentCard({ agent: a, size, picked, best, onPick, onHire, onAsk, starred, onStar, actions }: {
  agent: Agent; size: 'tile' | 'market' | 'chat'; picked?: boolean; best?: boolean;
  onPick?: () => void; onHire?: () => void; onAsk?: () => void; starred?: boolean; onStar?: () => void; actions?: ReactNode;
}) {
  const { t } = useT();
  const pill = statePill(t, a);

  const edge = a.total - a.hold;
  if (size === 'tile') {
    // A row, like AI Studio's "Featured" list: icon, name with small badges, one line, and the one number that
    // says something (how it did against just holding).
    return (
      <button className={`frow${picked ? ' on' : ''}`} onClick={onPick} aria-pressed={picked}>
        <span className={`frow-ic ag-r-${a.rule}`} aria-hidden><RuleIcon rule={a.rule} /></span>
        <span className="frow-main">
          <span className="frow-title">
            <b>{t.agRule[a.rule]}</b>
            <span className={`badge ${pill.cls}`}><i />{pill.text}</span>
            {best && <span className="badge pick"><i />{t.stratRec}</span>}
          </span>
          <span className="frow-desc">{t.agLine[a.rule]}</span>
        </span>
        <span className="frow-num">
          <b className={edge >= 0 ? 'pos' : 'neg'}>{t.vsHold(pct(edge))}</b>
          <small>{t.acTotal} {pct(a.total)} · {t.acDd} {drop(a.maxDd)}</small>
        </span>
        <span className="frow-go" aria-hidden>›</span>
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
    // Compact: Moa's column is narrow, so the card says who, what, three numbers; the rules fold away.
    return (
      <div className="acard">
        {head}
        <p className="ag-line">{t.agLine[a.rule]}</p>
        <div className="ag-stats">
          <span>{t.acEdge}<b className={edge >= 0 ? 'pos' : 'neg'}>{pct(edge)}</b></span>
          <span>{t.acTotal}<b>{pct(a.total)}</b></span>
          <span>{t.acDd}<b>{drop(a.maxDd)}</b></span>
        </div>
        <Equity pts={a.equity} up={a.total >= a.hold} wide />
        {!a.runnable && <p className="acard-demo">{t.whyNot(a.base)}</p>}
        <details className="acard-more">
          <summary>{t.acRules}</summary>
          <ul>{t.agRules[a.rule].map((r) => <li key={r}>{r}</li>)}</ul>
          <p className="acard-foot">{t.acFoot(`${(a.fee * 100).toFixed(1)}%`, a.days)}</p>
        </details>
        {actions}
      </div>
    );
  }

  // Market: a gallery card. Thumbnail (the equity curve), title, tags, one line, three numbers, actions.
  return (
    <article className={`ag-card${a.runnable ? '' : ' signal-only'}`}>
      <div className="ag-thumb">
        <Equity pts={a.equity} up={a.total >= a.hold} wide />
        <span className={`sig ${pill.cls}`}>{pill.text}</span>
      </div>
      <div className="ag-body">
        <div className="ag-title"><span className={`ag-avatar sm ag-r-${a.rule}`} aria-hidden><RuleIcon rule={a.rule} /></span><b>{agentName(t, a)}</b></div>
        <div className="ag-tags">
          <span className="tag"><CoinMark base={a.base} />{a.base}</span>
          <span className="tag">{t.agStyle[a.style]}</span>
          <span className={`tag ${a.runnable ? 'ok' : 'demo'}`}>{a.runnable ? t.acRunnable : t.acSignal}</span>
        </div>
        <p className="ag-line">{t.agLine[a.rule]}</p>
        <div className="ag-stats">
          <span>{t.acEdge}<b className={edge >= 0 ? 'pos' : 'neg'}>{pct(edge)}</b></span>
          <span>{t.acTotal}<b>{pct(a.total)}</b></span>
          <span>{t.acDd}<b>{drop(a.maxDd)}</b></span>
        </div>
      </div>
      <footer className="ag-card-foot">
        {a.runnable
          ? <button className="btn-primary sm" onClick={onHire}>{t.acHire}</button>
          : <span className="ag-signal-badge">{t.acSignal}</span>}
        <button className="btn-text" onClick={onAsk}>{t.acAsk}</button>
        {onStar && (
          <button className={`ag-star${starred ? ' on' : ''}`} onClick={onStar} aria-pressed={starred} aria-label={t.agStar} data-tip={t.agStar}>
            <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden><path d="M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2L2.5 8l5.2-.7L10 2.5z" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
          </button>
        )}
      </footer>
    </article>
  );
}
