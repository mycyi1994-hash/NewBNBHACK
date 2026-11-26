// One agent card in two sizes, so an agent looks and reads the same everywhere:
//  - tile: under the chart (tap → Moa explains it)
//  - chat: inside Moa's conversation (numbers, equity, rules; actions come from the conversation)
import type { ReactNode } from 'react';
import type { Agent, RuleId } from './agents.ts';
import { useT, type Strings } from './i18n.ts';
import { CoinMark } from './CoinMark.tsx';
import { Icon } from './Icons.tsx';

/** Signed percent with a true minus sign, one decimal: the one number format used across the app. */
export const pct = (v: number, d = 1) => { const x = Math.abs(v * 100).toFixed(d); return `${Number(x) === 0 ? '' : v > 0 ? '+' : '−'}${x}%`; };
export const drop = (v: number) => `−${(v * 100).toFixed(1)}%`;
export const multText = (m: number) => String(Math.round(m * 100) / 100);
/** An agent goes by a short name ("BTC Turtle"); the rule it follows ("Breakout · 20/10") is its subtitle. */
export const agentName = (t: Strings, a: { base: string; rule: RuleId }) => `${a.base} ${t.agNick[a.rule]}`;

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

const ICON: Partial<Record<RuleId, string>> = {
  tsmom: 'M3 15l4-4 3 2 6-7M13 6h4v4M3 17h14', trend200: 'M3 14c5 0 9-2 14-7M3 17h14', golden: 'M3 15c5 0 7-9 14-9M3 8c5 0 8 7 14 7',
  trend: 'M3 15l5-5 3 3 6-7', ema: 'M3 14c4 0 5-7 9-7 2 0 3 1 5 1M3 10c4 0 6 4 9 4 2 0 3-2 5-3',
  break: 'M3 13h5l2-6 2 9 2-5h3', rsi: 'M3 6h14M3 14h14M4 12l3-5 3 7 3-6 3 4', boll: 'M3 5c5 3 9 3 14 0M3 15c5-3 9-3 14 0M3 10h14',
  daily: 'M4 16h3v-3h3v-3h3V7h3', smart: 'M3 7c3 0 4 7 7 7s4-7 7-7M6 16h8', trendDca: 'M3 13l4-4 3 2 7-6M3 17h14', rsiDca: 'M4 16V9M8 16V5M12 16v-4M16 16V8',
};
/** An agent's face: its rule's icon on its own colour, the same wherever the agent appears. */
export function Face({ rule, size = 'md' }: { rule: RuleId; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`face r-${rule} ${size}`} aria-hidden><RuleIcon rule={rule} /></span>;
}
/** Added rules share the drawing of their family: momentum, channel breakout, moving averages, dip buying. */
const LIKE: Partial<Record<RuleId, RuleId>> = {
  multiTrend: 'tsmom', dualMom: 'tsmom', cryptoMom: 'tsmom', turtle2: 'break', donchian: 'break', keltner: 'break', psar: 'break',
  ma520: 'ema', triple: 'ema', macd: 'ema', ichimoku: 'golden', adx: 'trend200', aroon: 'trend200', rsi2: 'rsi', double7: 'rsi',
};
export function RuleIcon({ rule }: { rule: RuleId }) {
  return <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden><path d={ICON[rule] ?? ICON[LIKE[rule] ?? 'trend']} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}


export function AgentCard({ agent: a, size, picked, best, rank, onPick, actions }: {
  agent: Agent; size: 'tile' | 'chat'; picked?: boolean; best?: boolean; rank?: number; onPick?: () => void; actions?: ReactNode;
}) {
  const { t } = useT();
  const pill = statePill(t, a);

  const edge = a.total - a.hold;
  if (size === 'tile') {
    // A table row (the header lives in MarketAgents): who, state, the year's curve, then the three numbers in
    // their own columns so they line up down the table. The lead number is how it did against just holding.
    return (
      <button className={`frow${picked ? ' on' : ''}`} onClick={onPick} aria-pressed={picked}>
        <span className={`frow-rank${rank && rank <= 3 ? ' top' : ''}`}>{rank}</span>
        <span className="frow-who">
          <Face rule={a.rule} size="sm" />
          <span className="frow-main">
            <span className="frow-title"><b>{t.agNick[a.rule]}</b><span className="frow-rule">{t.agRule[a.rule]}</span>{a.tier === 1 && <span className="frow-star" data-tip={t.agOrigin[a.rule]}>★</span>}{best && <span className="badge pick"><i />{t.stratRec}</span>}</span>
            <span className="frow-desc">{t.agLine[a.rule]}</span>
          </span>
        </span>
        <span className="frow-origin"><span className={`origin tier-${a.tier}`}>{t.agOrigin[a.rule]}</span></span>
        <span className="frow-state"><span className={`badge ${pill.cls}`}><i />{pill.text}</span></span>
        <span className="frow-eq" aria-hidden><Equity pts={a.equity} up={a.total >= a.hold} /></span>
        <span className={`frow-n lead ${edge >= 0 ? 'pos' : 'neg'}`}>{pct(edge)}</span>
        <span className={`frow-n ${a.total >= 0 ? 'pos' : 'neg'}`}>{pct(a.total)}</span>
        <span className="frow-n">{drop(a.maxDd)}</span>
        <span className="frow-go" aria-hidden><Icon name="chevron" size={18} /></span>
      </button>
    );
  }

  const head = (
    <header className="ag-card-head">
      <Face rule={a.rule} />
      <div className="ag-card-title">
        <b>{agentName(t, a)}</b>
        <span className="ag-meta"><CoinMark base={a.base} />{t.agRule[a.rule]}</span>
      </div>
      <span className={`sig ${pill.cls}`}>{pill.text}</span>
    </header>
  );

  if (size === 'chat') {
    // Compact: Moa's column is narrow, so the card says who, what, three numbers; the rules fold away.
    return (
      <div className="acard">
        {head}
        <p className="ag-line">{t.agLine[a.rule]} <span className={`origin tier-${a.tier}`}>{t.agOrigin[a.rule]}</span></p>
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
  return null;
}
