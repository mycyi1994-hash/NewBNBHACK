// Agent market, in two tabs (after the attached marketplace reference):
//  - Top agents: the ten best equity curves on one chart with a ranked legend, then a ranking table.
//    "Steady" ranks by Sharpe, "Aggressive" by period return. Only agents you can hire are ranked.
//  - Marketplace: search and filters, then one card per agent: the lead number with its equity curve,
//    six readings, and one full-width action.
// It shows; it does not run anything. "Hire" opens the hire sheet over this page, a row or a card title
// hands the agent to Moa on the right. Every number comes from agents.ts; nothing is invented, so there are
// no creators, followers or subscriber counts here.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SlidePill } from './motion.tsx';
import { StateBox } from './ui.tsx';
import { useT } from './i18n.ts';
import { byMerit, idle, type Agent, type Tier } from './agents.ts';
import { agentName, drop, pct, statePill, Equity, Face } from './AgentCard.tsx';
import { Icon, Spark } from './Icons.tsx';

type Tab = 'top' | 'market';
type Rank = 'classic' | 'steady' | 'bold';
type Sort = 'pick' | 'dd' | 'total' | 'sharpe';
const LINE = ['#3b5bdb', '#12b886', '#15aabf', '#f08c00', '#e03131', '#9c36b5', '#868e96', '#f783ac', '#4dabf7', '#fab005'];
const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const day = (s: number) => { const d = new Date(s * 1000); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };

function readStars(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('moa.stars') ?? '[]') as string[]); } catch { return new Set(); }
}

/** Equity of the ranked agents over their shared window, as % from the start of that window. */
function TopChart({ agents }: { agents: Agent[] }) {
  const { lang } = useT();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 760, rem: 14 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setSize({ w: Math.max(240, Math.round(el.clientWidth)), rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 14 });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Drawn in real pixels (not a scaled viewBox), so the axis labels keep the size of the rest of the text.
  const u = size.rem / 14, W = size.w, H = Math.round(Math.min(360 * u, Math.max(190 * u, W * 0.36))), L = 42 * u, R = 8 * u, T = 10 * u, B = 26 * u;
  const from = Math.max(...agents.map((a) => a.equity[0]?.time ?? 0));
  const series = agents.map((a) => {
    const pts = a.equity.filter((p) => p.time >= from);
    const base = pts[0]?.value ?? 1;
    return pts.map((p) => ({ time: p.time, v: p.value / base - 1 }));
  });
  const all = series.flat();
  if (!all.length) return <div className="top-chart" ref={box} />;
  const t0 = Math.min(...all.map((p) => p.time)), t1 = Math.max(...all.map((p) => p.time));
  const step = (Math.max(...all.map((p) => Math.abs(p.v))) > 1 ? 0.5 : 0.25);
  const lo = Math.floor(Math.min(0, ...all.map((p) => p.v)) / step) * step, hi = Math.ceil(Math.max(0, ...all.map((p) => p.v)) / step) * step || step;
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const marks: number[] = []; for (let v = lo; v <= hi + 1e-9; v += step) marks.push(+v.toFixed(4));
  const months = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => t0 + f * (t1 - t0));
  const fmt = (t: number) => new Date(t * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'short' });
  return (
    <div className="top-chart" ref={box}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="equity">
      {marks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis-zero' : 'axis-line'} /><text x={L - 8 * u} y={y(v) + 4 * u} textAnchor="end" className="axis-text">{Math.round(v * 100)}%</text></g>)}
      {[...series].reverse().map((s, k) => {
        const i = series.length - 1 - k;
        return (
          <path key={agents[i].id} className="draw" pathLength={1} style={{ animationDelay: `${i * 0.05}s` }}
            d={s.filter((_, n) => n % 2 === 0 || n === s.length - 1).map((p, n) => `${n ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}
            fill="none" stroke={LINE[i % LINE.length]} strokeWidth={(i === 0 ? 2.2 : 1.5) * u} strokeLinejoin="round" />
        );
      })}
      {months.map((t, i) => <text key={i} x={x(t)} y={H - 6 * u} textAnchor="middle" className="axis-text">{fmt(t)}</text>)}
    </svg>
    </div>
  );
}

export default function Agents({ agents, failed, onRetry, onHire, onOpen, onRecommend }: {
  agents: Agent[] | null; failed: boolean; onRetry: () => void; onHire: (a: Agent) => void; onOpen: (a: Agent) => void; onRecommend: () => void;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('top');
  const [rank, setRank] = useState<Rank>('classic');
  const [q, setQ] = useState('');
  const [asset, setAsset] = useState('all');
  const [origin, setOrigin] = useState<'all' | '1' | '2' | '3'>('all');
  const [sort, setSort] = useState<Sort>('pick');
  const [stars, setStars] = useState<Set<string>>(readStars);

  const runnable = useMemo(() => (agents ?? []).filter((a) => a.runnable), [agents]);
  // "Published classics" is the first tab: only strategies with a public record, best risk-adjusted result first.
  const ranked = useMemo(() => (rank === 'classic' ? runnable.filter((a) => a.tier === 1) : [...runnable])
    .sort((p, r) => Number(idle(p)) - Number(idle(r)) || (rank === 'bold' ? r.total - p.total : r.sharpe - p.sharpe)), [runnable, rank]);
  const top = ranked.slice(0, 10);
  const assets = useMemo(() => runnable.map((a) => a.base).filter((b, i, xs) => xs.indexOf(b) === i), [runnable]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // Only agents that can be hired; a coin without an HSKSwap pool shows its signal-only agents on its own chart.
    const xs = runnable.filter((a) => (asset === 'all' || a.base === asset) && (origin === 'all' || String(a.tier) === origin)
      && (!needle || agentName(t, a).toLowerCase().includes(needle)));
    return xs.sort((p, r) => (sort === 'pick' ? byMerit(p, r) : sort === 'sharpe' ? r.sharpe - p.sharpe : sort === 'total' ? r.total - p.total : p.maxDd - r.maxDd));
  }, [runnable, q, asset, sort, origin, t]);

  const star = (id: string) => setStars((cur) => {
    const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem('moa.stars', JSON.stringify([...next])); } catch { /* storage unavailable */ }
    return next;
  });

  return (
    <div className="page market-page">
      <nav className="subnav has-line" aria-label={t.agTitle}>
        <SlidePill dep={tab} />
        {(['top', 'market'] as Tab[]).map((k) => <button key={k} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{k === 'top' ? t.mpTabTop : t.mpTabMarket}</button>)}
      </nav>

      <header className="mp-head">
        {tab === 'top'
          ? <h1>{t.topHead1} <span className="grad">{t.topHead2}</span></h1>
          : <h1>{t.mpTitle}</h1>}
        <button className="btn-dark" onClick={onRecommend}><Spark size={14} />{t.barRecommend}</button>
      </header>

      {failed && <StateBox title={t.errAgents} text={t.agFailed} retry={t.retry} onRetry={onRetry} />}
      {/* Nothing to rank or list without the candles: the message above is the whole page. */}

      {!failed && tab === 'top' && (
        <>
          <div className="rank-tabs has-line" role="tablist">
            <SlidePill dep={rank} />
            {(['classic', 'steady', 'bold'] as Rank[]).map((k) => <button key={k} role="tab" aria-selected={rank === k} className={rank === k ? 'on' : ''} onClick={() => setRank(k)}>{k === 'classic' ? t.topClassic : k === 'steady' ? t.topSteady : t.topBold}</button>)}
          </div>

          <section className="top-panel">
            <div className="top-main">
              <div className="top-title">{t.topChart(top.length || 10)} <small>{t.topChartSub}</small></div>
              {agents ? <TopChart key={rank} agents={top} /> : <div className="top-skel skel-block" />}
            </div>
            <div className="top-legend">
              <div className="top-legend-head"><span>{t.topLegendA}</span><span>{top[0] ? t.topLegendB(top[0].days) : ''}</span></div>
              <ol>
                {(agents ? top : Array.from({ length: 10 }, (_, i) => i)).map((a, i) => typeof a === 'number'
                  ? <li key={i}><span className="skel" style={{ width: '70%' }} /></li>
                  : (
                    <li key={a.id}>
                      <button onClick={() => onOpen(a)}>
                        <span className="lg-n">{i + 1}</span>
                        <i style={{ background: LINE[i % LINE.length] }} />
                        <span className="lg-name">{agentName(t, a)}</span>
                        <span className={`lg-v ${sign(a.total)}`}>{pct(a.total)}</span>
                      </button>
                    </li>
                  ))}
              </ol>
            </div>
          </section>

          <div className="rank-table" role="table" aria-label={t.mpTabTop}>
            <div className="rank-head" role="row">
              <span>{t.thRank}</span><span>{t.thName}</span><span>{t.thEdge}</span><span>{t.thTotal}</span><span>{t.thSharpe}</span><span>{t.thDd}</span><span>{t.thTrades}</span><span>{t.thPeriod}</span>
            </div>
            {!agents && !failed && [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="rank-row skel-block" />)}
            {ranked.map((a, i) => (
              <button key={a.id} className={`rank-row${i < 3 ? ` medal-${i + 1}` : ''}`} role="row" onClick={() => onOpen(a)}>
                <span className="rank-n">{i < 3 ? <Icon name="medal" size={16} /> : i + 1}</span>
                <span className="rank-name">
                  <b>{agentName(t, a)}</b>
                  <small><span className={`origin tier-${a.tier}`}>{t.agOrigin[a.rule]}</span><span className="rank-src">{t.agRule[a.rule]}</span></small>
                </span>
                <span className={sign(a.total - a.hold)}>{pct(a.total - a.hold)}</span>
                <span className={sign(a.total)}>{pct(a.total)}</span>
                <span>{a.sharpe.toFixed(2)}</span>
                <span>{drop(a.maxDd)}</span>
                <span>{a.trades.toLocaleString('en-US')}</span>
                <span className="rank-period">{day(a.from)}<br />{day(a.to)}</span>
              </button>
            ))}
          </div>
          <p className="muted small">{t.topNote(runnable.length)} {t.agFoot}</p>
        </>
      )}

      {!failed && tab === 'market' && (
        <>
          <div className="mp-filters">
            <label className="mp-search"><Icon name="search" size={16} /><input id="mp-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.mpSearch} aria-label={t.mpSearch} autoComplete="off" /></label>
            <select value={asset} onChange={(e) => setAsset(e.target.value)} aria-label={t.fAsset}>
              <option value="all">{t.fAsset}</option>
              {assets.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <select value={origin} onChange={(e) => setOrigin(e.target.value as 'all' | '1' | '2' | '3')} aria-label={t.fOrigin}>
              <option value="all">{t.fOrigin}</option>
              {([1, 2, 3] as Tier[]).map((k) => <option key={k} value={String(k)}>{t.agTier[k]}</option>)}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t.fSort}>
              {(['pick', 'dd', 'total', 'sharpe'] as Sort[]).map((k) => <option key={k} value={k}>{t.fSort}: {k === 'pick' ? t.sortPick : t.agSort[k]}</option>)}
            </select>
          </div>

          <div className="mp-grid stagger" key={`${asset}-${sort}-${origin}`}>
            {!agents && !failed && [0, 1, 2, 3].map((i) => <div key={i} className="mp-card mp-skel skel-block" />)}
            {shown.map((a) => {
              const pill = statePill(t, a);
              const edge = a.total - a.hold;
              return (
                <article key={a.id} className={`mp-card${a.runnable ? '' : ' signal-only'}`}>
                  <button className="mp-title" onClick={() => onOpen(a)}>
                    <Face rule={a.rule} />
                    <span className="mp-name"><b>{agentName(t, a)}</b><small>{t.agRule[a.rule]}</small></span>
                  </button>
                  <div className="mp-meta">
                    <span className={`origin tier-${a.tier}`}>{t.agOrigin[a.rule]}</span>
                    <span className={`badge ${pill.cls}`}><i />{pill.text}</span>
                  </div>
                  <div className="mp-lead">
                    <div>
                      <small>{t.cardEdge(a.days)}</small>
                      <b className={sign(edge)}>{pct(edge)}</b>
                    </div>
                    <Equity pts={a.equity} up={edge >= 0} />
                  </div>
                  <dl className="mp-stats">
                    <div><dt>{t.thTotal}</dt><dd className={sign(a.total)}>{pct(a.total)}</dd></div>
                    <div><dt>{t.thDd}</dt><dd>{drop(a.maxDd)}</dd></div>
                    <div><dt>{t.thSharpe}</dt><dd>{a.sharpe.toFixed(2)}</dd></div>
                  </dl>
                  <footer className="mp-foot">
                    <button className={`mp-star${stars.has(a.id) ? ' on' : ''}`} onClick={() => star(a.id)} aria-pressed={stars.has(a.id)} aria-label={t.agStar} data-tip={t.agStar}>
                      <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden><path d="M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2L2.5 8l5.2-.7L10 2.5z" fill={stars.has(a.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
                    </button>
                    <button className="mp-run ghost" onClick={() => onOpen(a)}>{t.acBacktest}</button>
                    <button className="mp-run" onClick={() => onHire(a)}>{t.acHire}</button>
                  </footer>
                </article>
              );
            })}
          </div>
          {agents && !shown.length && <p className="muted">{t.mpNone}</p>}
          <p className="muted small">{t.agFoot}</p>
        </>
      )}
    </div>
  );
}
