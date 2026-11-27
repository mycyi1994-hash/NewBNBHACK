// One agent card in two sizes, so an agent looks and reads the same everywhere:
//  - tile: under the chart (tap → Moa explains it)
//  - chat: inside Moa's conversation (numbers, equity, rules; actions come from the conversation)
import type { ReactNode } from 'react';
import { ACTIVE_DAYS, lastTradeDays, type Agent, type RuleId } from './agents.ts';
import { useT, type Strings } from './i18n.ts';
import { CoinMark } from './CoinMark.tsx';
import { Icon } from './Icons.tsx';
import { madeById } from './madeStore.ts';
import type { Cond, MadeSpec } from './spec.ts';
import { Mark, RuleGlyph } from './Mark.tsx';

/** Signed percent with a true minus sign, one decimal: the one number format used across the app. */
export const pct = (v: number, d = 1) => { const x = Math.abs(v * 100).toFixed(d); return `${Number(x) === 0 ? '' : v > 0 ? '+' : '−'}${x}%`; };
export const drop = (v: number) => `−${(v * 100).toFixed(1)}%`;
export const multText = (m: number) => String(Math.round(m * 100) / 100);
/** An agent goes by a short name ("BTC Turtle"); the rule it follows ("Breakout · 20/10") is its subtitle. */
export function agentName(t: Strings, a: { base: string; rule: RuleId; made?: { name: string }; id?: string; agentId?: string }): string {
  // A made agent goes by the name its maker gave it (a hired one only carries its id, so the name is looked up).
  if (a.rule === 'made') return a.made?.name ?? madeById(a.agentId ?? a.id ?? '')?.name ?? t.agNick.made;
  return `${a.base} ${t.agNick[a.rule]}`;
}
/** A condition as "price > 200-day average". */
export const condText = (t: Strings, c: Cond) => `${t.term(c.a.k, c.a.n)} ${c.op === 'above' ? '>' : '<'} ${t.term(c.b.k, c.b.n, c.a.k === 'ret')}`;
/** The rule in two lines, for a made agent; the built-in text otherwise. */
export const ruleLines = (t: Strings, a: { rule: RuleId; made?: MadeSpec }): string[] => (a.made
  ? [`${t.cuBuy}: ${a.made.buy.map((c) => condText(t, c)).join(` ${t.cuAnd} `)}`, a.made.sell.length ? `${t.cuSell}: ${a.made.sell.map((c) => condText(t, c)).join(` ${t.cuOr} `)}` : t.cuSellNone]
  : t.agRules[a.rule].slice(0, 2));

export function statePill(t: Strings, a: Agent): { text: string; cls: string } {
  if (a.kind === 'position') return a.live ? { text: t.acHolding, cls: 'sig-good' } : { text: t.acWaiting, cls: 'sig-neutral' };
  return a.mult > 0 ? { text: t.acToday(multText(a.mult)), cls: a.mult > 1 ? 'sig-good' : 'sig-neutral' } : { text: t.acRest, cls: 'sig-wait' };
}
/**
 * How recently the agent did something, in words: "Holding now", "Bought 5 days ago", "Sold 23 days ago".
 * `on` is true when that counts as working now (the same ACTIVE_DAYS as `active` in agents.ts).
 */
export function freshLine(t: Strings, a: Agent): { text: string; on: boolean } {
  if (a.live) return { text: a.kind === 'position' ? t.frHolding : t.frBuyToday, on: true };
  const d = lastTradeDays(a);
  if (d === undefined) return { text: t.frNever, on: false };
  const last = a.marks.reduce((p, m) => (m.time >= p.time ? m : p), a.marks[0]);
  return { text: t.frAgo(d, last.side === 'buy'), on: d <= ACTIVE_DAYS };
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

/**
 * An agent's face: its mark (family colour, rule symbol, coin badge), the same wherever the agent appears.
 * sm 28px (lists, dock), md 36px (cards in conversation), lg 44px (backtest title), xl 56px (market card).
 * Pass `base` to put the coin in the corner; the letter shows from lg up.
 */
export function Face({ rule, size = 'md', base }: { rule: RuleId; size?: 'sm' | 'md' | 'lg' | 'xl'; base?: string }) {
  return <span className={`face mark ${size}`} aria-hidden><Mark rule={rule} base={base} letter={size === 'lg' || size === 'xl'} /></span>;
}
/** The rule's symbol on its own, in the current text colour. */
export function RuleIcon({ rule }: { rule: RuleId }) {
  return <RuleGlyph rule={rule} />;
}

export function AgentCard({ agent: a, size, picked, best, rank, onPick, actions }: {
  agent: Agent; size: 'tile' | 'cell' | 'chat'; picked?: boolean; best?: boolean; rank?: number; onPick?: () => void; actions?: ReactNode;
}) {
  const { t } = useT();
  const pill = statePill(t, a);

  const edge = a.total - a.hold;
  if (size === 'cell') {
    // One row of a horizon's column under the chart: who, the strategy in a few words, what it returned over the
    // year and its worst drop on the way. What just holding returned is in the column's header, once.
    const active = pill.cls === 'sig-good';
    return (
      <button className={`hzr${picked ? ' on' : ''}`} onClick={onPick} aria-pressed={picked}>
        <span className="hzr-rank">{rank}</span>
        <Face rule={a.rule} size="sm" />
        <span className="hzr-main">
          <span className="hzr-title"><b>{a.made?.name ?? t.agNick[a.rule]}</b>{best && <span className="badge pick"><i />{t.stratRec}</span>}</span>
          <span className="hzr-rule">{active && <em>{pill.text} · </em>}{t.agRule[a.rule]}</span>
        </span>
        <span className="hzr-eq" aria-hidden><Equity pts={a.equity} up={a.total >= 0} /></span>
        <span className="hzr-num"><b className={a.total >= 0 ? 'pos' : 'neg'}>{pct(a.total)}</b><small>{t.ddShort} {drop(a.maxDd)}</small></span>
      </button>
    );
  }
  if (size === 'tile') {
    // A table row (the header lives in MarketAgents): who, state, the year's curve, then the three numbers in
    // their own columns so they line up down the table. The lead number is how it did against just holding.
    return (
      <button className={`frow${picked ? ' on' : ''}`} onClick={onPick} aria-pressed={picked}>
        <span className={`frow-rank${rank && rank <= 3 ? ' top' : ''}`}>{rank}</span>
        <span className="frow-who">
          <Face rule={a.rule} size="sm" />
          <span className="frow-main">
            <span className="frow-title"><b>{a.made?.name ?? t.agNick[a.rule]}</b><span className="frow-rule">{t.agRule[a.rule]}</span>{a.tier === 1 && <span className="frow-star" data-tip={t.agOrigin[a.rule]}>★</span>}{best && <span className="badge pick"><i />{t.stratRec}</span>}</span>
            <span className="frow-desc">{a.made ? ruleLines(t, a)[0] : t.agLine[a.rule]}</span>
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
      <Face rule={a.rule} base={a.base} />
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
          <p className="acard-foot">{t.acFoot(`${(a.fee * 100).toFixed(1)}%`, a.days, a.interval)}</p>
        </details>
        {actions}
      </div>
    );
  }
  return null;
}
