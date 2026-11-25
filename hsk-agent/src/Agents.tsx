// Agent market: Moa's rule-based trading agents, ranked by their backtests on HashKey Global daily candles.
// Top: equity curves of the five best agents and a ranking. Below: filters and one card per agent.
// "Use this agent" opens the trade screen on that market with the agent's card in Moa's panel.
import { useEffect, useMemo, useState } from 'react';
import { useT } from './i18n.ts';
import { loadAgents, AGENT_MARKETS, type Agent, type RuleId } from './agents.ts';
import { RollNum, SlidePill } from './motion.tsx';
import { CoinMark } from './CoinMark.tsx';
import type { StratNote } from './Strategies.tsx';
import type * as cex from './cex.ts';

const pct = (v: number, d = 1) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const LINE = ['#7c5cf0', '#16a34a', '#f59e0b', '#0ea5e9', '#db2777'];
type Sort = 'sharpe' | 'cagr' | 'dd';
type StyleF = 'all' | 'trend' | 'revert';

function readStars(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('moa.stars') ?? '[]') as string[]); } catch { return new Set(); }
}

/** Small equity curve for a card. */
function Equity({ pts, up }: { pts: { value: number }[]; up: boolean }) {
  const W = 160, H = 56;
  const xs = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 120)) === 0 || i === pts.length - 1);
  const lo = Math.min(...xs.map((p) => p.value)), hi = Math.max(...xs.map((p) => p.value)), span = hi - lo || 1;
  const d = xs.map((p, i) => `${i ? 'L' : 'M'}${((i / (xs.length - 1)) * W).toFixed(1)},${(H - 3 - ((p.value - lo) / span) * (H - 6)).toFixed(1)}`).join('');
  const color = up ? '#16a34a' : '#dc2626';
  return (
    <svg className="ag-eq" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={`${d}L${W},${H}L0,${H}Z`} fill={color} opacity=".1" />
      <path className="draw" pathLength={1} d={d} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Equity of the top agents over the same window, as % from the start. */
function TopChart({ agents }: { agents: Agent[] }) {
  const { lang } = useT();
  const W = 760, H = 230, P = 8;
  const from = Math.max(...agents.map((a) => a.equity[0].time));
  const series = agents.map((a) => {
    const pts = a.equity.filter((p) => p.time >= from);
    const base = pts[0]?.value ?? 1;
    return pts.map((p) => ({ time: p.time, v: p.value / base - 1 }));
  });
  const all = series.flat();
  if (!all.length) return null;
  const t0 = Math.min(...all.map((p) => p.time)), t1 = Math.max(...all.map((p) => p.time));
  const lo = Math.min(0, ...all.map((p) => p.v)), hi = Math.max(...all.map((p) => p.v));
  const x = (t: number) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const TOP = 18;
  const y = (v: number) => TOP + (1 - (v - lo) / (hi - lo || 1)) * (H - TOP - P - 16);
  const marks = [hi, 0, ...(-lo > 0.15 * (hi - lo) ? [lo] : [])];
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0));
  const fmt = (t: number) => new Date(t * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US', { year: '2-digit', month: 'short' });
  return (
    <svg className="ag-top-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="equity">
      {marks.map((v, i) => <g key={i}><line x1={P} x2={W - P} y1={y(v)} y2={y(v)} stroke={v === 0 ? '#d9d5cf' : '#f1efec'} strokeDasharray={v === 0 ? '0' : '3 4'} /><text x={W - P} y={y(v) - 4} textAnchor="end" className="ag-axis">{pct(v, 0)}</text></g>)}
      {series.map((s, i) => (
        <path key={i} className="draw" pathLength={1} style={{ animationDelay: `${i * 0.12}s` }}
          d={s.filter((_, k) => k % 2 === 0 || k === s.length - 1).map((p, k) => `${k ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}
          fill="none" stroke={LINE[i]} strokeWidth={i === 0 ? 2.4 : 1.6} strokeLinejoin="round" />
      ))}
      {ticks.map((t, i) => <text key={i} x={x(t)} y={H - 2} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} className="ag-axis">{fmt(t)}</text>)}
    </svg>
  );
}

export default function Agents({ onUse }: { onUse: (market: cex.Market, note: StratNote) => void }) {
  const { t } = useT();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [asset, setAsset] = useState<string>('all');
  const [style, setStyle] = useState<StyleF>('all');
  const [sort, setSort] = useState<Sort>('sharpe');
  const [stars, setStars] = useState<Set<string>>(readStars);

  useEffect(() => { loadAgents().then(setAgents, () => setFailed(true)); }, []);

  const name = (a: Agent) => `${a.market.base} ${t.agRule[a.rule]}`;
  const ranked = useMemo(() => (agents ? [...agents].sort((p, q) => q.sharpe - p.sharpe) : []), [agents]);
  const top = ranked.slice(0, 5);
  const shown = useMemo(() => {
    if (!agents) return [];
    const xs = agents.filter((a) => (asset === 'all' || a.market.base === asset) && (style === 'all' || a.style === style));
    return xs.sort((p, q) => (sort === 'sharpe' ? q.sharpe - p.sharpe : sort === 'cagr' ? q.cagr - p.cagr : p.maxDd - q.maxDd));
  }, [agents, asset, style, sort]);

  const star = (id: string) => setStars((cur) => {
    const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem('moa.stars', JSON.stringify([...next])); } catch { /* storage unavailable */ }
    return next;
  });

  const use = (a: Agent) => {
    const rules = t.agRules[a.rule];
    const note: StratNote = {
      n: Date.now(), venue: 'cex', name: name(a), signal: a.live ? 'good' : 'neutral',
      value: pct(a.cagr), valueLabel: t.agCagrOver(a.days), good: a.cagr > 0, bad: a.cagr < 0,
      facts: [[t.agTotal, pct(a.total)], [t.agDd, `−${(a.maxDd * 100).toFixed(1)}%`], [t.agSharpe, a.sharpe.toFixed(2)], [t.agHold, pct(a.hold)]],
      rules, text: t.agExplain(name(a), pct(a.total), pct(a.hold), (a.maxDd * 100).toFixed(0), a.trades, a.live),
      source: t.agSource(a.market.base, a.market.kind === 'perp'),
      spark: { closes: a.equity.slice(-180).map((p) => p.value) },
      follow: [t.agPrompt(a.market.base, t.agRule[a.rule]), t.fuRisk(name(a))],
    };
    onUse(a.market, note);
  };

  const assets = ['all', ...AGENT_MARKETS.map((m) => m.base).filter((b, i, xs) => xs.indexOf(b) === i)];

  return (
    <div className="page agents-page">
      <header className="ag-head">
        <div>
          <h1>{t.agTitle}</h1>
          <p className="muted">{t.agSub}</p>
        </div>
      </header>

      <section className="ag-top">
        <div className="ag-top-main">
          <div className="ag-sec-title">{t.agTopTitle} <span className="muted">{t.agTopSub}</span></div>
          {agents ? <TopChart agents={top} /> : <div className="ag-top-skel skel-block" />}
        </div>
        <ol className="ag-rank">
          {(agents ? top : [0, 1, 2, 3, 4]).map((a, i) => typeof a === 'number'
            ? <li key={i} className="ag-rank-row"><span className="skel" style={{ width: 140 }} /></li>
            : (
              <li key={a.id} className="ag-rank-row">
                <span className="ag-rank-n">{i + 1}</span>
                <span className="ag-dot" style={{ background: LINE[i] }} />
                <span className="ag-rank-name">{name(a)}</span>
                <span className={`ag-rank-v ${a.cagr >= 0 ? 'pos' : 'neg'}`}>{pct(a.cagr)}</span>
              </li>
            ))}
        </ol>
      </section>

      <div className="ag-filters">
        <div className="coin-switch has-pill" role="tablist" aria-label={t.agAsset}>
          <SlidePill dep={asset} />
          {assets.map((b) => <button key={b} role="tab" aria-selected={asset === b} className={asset === b ? 'on' : ''} onClick={() => setAsset(b)}>{b === 'all' ? t.agAll : b}</button>)}
        </div>
        <div className="coin-switch has-pill" role="tablist" aria-label={t.agStyleLabel}>
          <SlidePill dep={style} />
          {(['all', 'trend', 'revert'] as StyleF[]).map((s) => <button key={s} role="tab" aria-selected={style === s} className={style === s ? 'on' : ''} onClick={() => setStyle(s)}>{t.agStyle[s]}</button>)}
        </div>
        <label className="ag-sort">
          <span className="muted">{t.agSortLabel}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {(['sharpe', 'cagr', 'dd'] as Sort[]).map((s) => <option key={s} value={s}>{t.agSort[s]}</option>)}
          </select>
        </label>
      </div>

      {failed && <p className="muted">{t.agFailed}</p>}
      <div className="ag-grid stagger" key={`${asset}-${style}-${sort}`}>
        {!agents && !failed && [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="ag-card ag-skel skel-block" />)}
        {shown.map((a) => (
          <article key={a.id} className="ag-card">
            <header className="ag-card-head">
              <span className={`ag-avatar ag-r-${a.rule}`} aria-hidden><RuleIcon rule={a.rule} /></span>
              <div className="ag-card-title">
                <b>{name(a)}</b>
                <span className="ag-meta"><CoinMark base={a.market.base} />{a.market.base} {a.market.kind === 'perp' ? t.perpetual : t.spotTag} · {t.agBy}</span>
              </div>
              <span className={`sig ${a.live ? 'sig-good' : 'sig-neutral'}`}>{a.live ? t.agLive : t.agWaiting}</span>
            </header>
            <p className="ag-line">{t.agLine[a.rule]}</p>
            <div className="ag-main">
              <div>
                <small>{t.agCagr}</small>
                <RollNum flash={false} className={`ag-big ${a.cagr >= 0 ? 'pos' : 'neg'}`} text={pct(a.cagr)} />
              </div>
              <Equity pts={a.equity} up={a.total >= 0} />
            </div>
            <dl className="ag-metrics">
              <div><dt>{t.agTotal}</dt><dd className={a.total >= 0 ? 'pos' : 'neg'}>{pct(a.total)}</dd></div>
              <div><dt>{t.agDd}</dt><dd>−{(a.maxDd * 100).toFixed(1)}%</dd></div>
              <div><dt>{t.agSharpe}</dt><dd>{a.sharpe.toFixed(2)}</dd></div>
              <div><dt>{t.agHold}</dt><dd className={a.hold >= 0 ? 'pos' : 'neg'}>{pct(a.hold)}</dd></div>
              <div><dt>{t.agTrades}</dt><dd>{a.trades}</dd></div>
              <div><dt>{t.agDays}</dt><dd>{a.days}{t.agDayUnit}</dd></div>
            </dl>
            <footer className="ag-card-foot">
              <button className={`ag-star${stars.has(a.id) ? ' on' : ''}`} onClick={() => star(a.id)} aria-pressed={stars.has(a.id)} aria-label={t.agStar} data-tip={t.agStar}>
                <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden><path d="M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2L2.5 8l5.2-.7L10 2.5z" fill={stars.has(a.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
              </button>
              <button className="btn-primary ag-use" onClick={() => use(a)}>{t.agUse}</button>
            </footer>
          </article>
        ))}
      </div>
      <p className="muted small">{t.agFoot}</p>
    </div>
  );
}

function RuleIcon({ rule }: { rule: RuleId }) {
  const d: Record<RuleId, string> = {
    trend: 'M3 15l5-5 3 3 6-7', ema: 'M3 14c4 0 5-7 9-7 2 0 3 1 5 1M3 10c4 0 6 4 9 4 2 0 3-2 5-3',
    break: 'M3 13h5l2-6 2 9 2-5h3', rsi: 'M3 6h14M3 14h14M4 12l3-5 3 7 3-6 3 4', boll: 'M3 5c5 3 9 3 14 0M3 15c5-3 9-3 14 0M3 10h14',
  };
  return <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden><path d={d[rule]} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
