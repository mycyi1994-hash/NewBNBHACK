// Agent market: every agent Moa scores, with the same card and numbers as the tiles and Moa's cards.
// It shows; it does not run anything. "Hire" opens the hire sheet over this page, "Ask Moa" hands the card
// to the conversation on the right. Neither button leaves the page.
// Agents for coins without an HSKSwap pool stay listed as "Signal only" (a demo); the page opens on the
// agents you can hire.
import { useMemo, useState } from 'react';
import { useT } from './i18n.ts';
import { type Agent } from './agents.ts';
import { SlidePill } from './motion.tsx';
import { AgentCard, agentName } from './AgentCard.tsx';

const LINE = ['#7c5cf0', '#16a34a', '#f59e0b', '#0ea5e9', '#db2777'];
type Sort = 'sharpe' | 'total' | 'dd';
type StyleF = 'all' | 'trend' | 'revert' | 'collect';
type RunF = 'run' | 'signal' | 'all';
const pct0 = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;

function readStars(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('moa.stars') ?? '[]') as string[]); } catch { return new Set(); }
}

/** Equity of the top agents over their shared window, as % from the start of that window. */
function TopChart({ agents }: { agents: Agent[] }) {
  const { lang } = useT();
  const W = 760, H = 230, P = 8;
  if (!agents.length) return null;
  const from = Math.max(...agents.map((a) => a.equity[0]?.time ?? 0));
  const series = agents.map((a) => {
    const pts = a.equity.filter((p) => p.time >= from);
    const base = pts[0]?.value ?? 1;
    return pts.map((p) => ({ time: p.time, v: p.value / base - 1 }));
  });
  const all = series.flat();
  if (!all.length) return null;
  const t0 = Math.min(...all.map((p) => p.time)), t1 = Math.max(...all.map((p) => p.time));
  const lo = Math.min(0, ...all.map((p) => p.v)), hi = Math.max(0, ...all.map((p) => p.v));
  const x = (t: number) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const TOP = 18;
  const y = (v: number) => TOP + (1 - (v - lo) / (hi - lo || 1)) * (H - TOP - P - 16);
  const marks = [hi, 0, ...(-lo > 0.15 * (hi - lo) ? [lo] : [])].filter((v, i, xs) => xs.indexOf(v) === i);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0));
  const fmt = (t: number) => new Date(t * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US', { year: '2-digit', month: 'short' });
  return (
    <svg className="ag-top-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="equity">
      {marks.map((v, i) => <g key={i}><line x1={P} x2={W - P} y1={y(v)} y2={y(v)} stroke={v === 0 ? '#d9d5cf' : '#f1efec'} strokeDasharray={v === 0 ? '0' : '3 4'} /><text x={W - P} y={y(v) - 4} textAnchor="end" className="ag-axis">{pct0(v)}</text></g>)}
      {series.map((s, i) => (
        <path key={i} className="draw" pathLength={1} style={{ animationDelay: `${i * 0.12}s` }}
          d={s.filter((_, k) => k % 2 === 0 || k === s.length - 1).map((p, k) => `${k ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}
          fill="none" stroke={LINE[i]} strokeWidth={i === 0 ? 2.4 : 1.6} strokeLinejoin="round" />
      ))}
      {ticks.map((t, i) => <text key={i} x={x(t)} y={H - 2} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} className="ag-axis">{fmt(t)}</text>)}
    </svg>
  );
}

export default function Agents({ agents, failed, onHire, onAsk }: {
  agents: Agent[] | null; failed: boolean; onHire: (a: Agent) => void; onAsk: (a: Agent) => void;
}) {
  const { t } = useT();
  const [run, setRun] = useState<RunF>('run');
  const [asset, setAsset] = useState<string>('all');
  const [style, setStyle] = useState<StyleF>('all');
  const [sort, setSort] = useState<Sort>('sharpe');
  const [stars, setStars] = useState<Set<string>>(readStars);

  const inView = useMemo(() => (agents ?? []).filter((a) => (run === 'all' || a.runnable === (run === 'run'))), [agents, run]);
  const shown = useMemo(() => {
    const xs = inView.filter((a) => (asset === 'all' || a.base === asset) && (style === 'all' || a.style === style));
    return xs.sort((p, q) => (sort === 'sharpe' ? q.sharpe - p.sharpe : sort === 'total' ? q.total - p.total : p.maxDd - q.maxDd));
  }, [inView, asset, style, sort]);
  const top = useMemo(() => [...shown].sort((p, q) => q.sharpe - p.sharpe).slice(0, 5), [shown]);
  const assets = ['all', ...inView.map((a) => a.base).filter((b, i, xs) => xs.indexOf(b) === i)];

  const star = (id: string) => setStars((cur) => {
    const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem('moa.stars', JSON.stringify([...next])); } catch { /* storage unavailable */ }
    return next;
  });

  return (
    <div className="page agents-page">
      <header className="ag-head">
        <div>
          <h1>{t.agTitle}</h1>
          <p className="muted">{t.agSub}</p>
        </div>
      </header>

      <div className="ag-filters">
        <div className="coin-switch has-pill" role="tablist" aria-label={t.agRunLabel}>
          <SlidePill dep={run} />
          {(['run', 'signal', 'all'] as RunF[]).map((r) => <button key={r} role="tab" aria-selected={run === r} className={run === r ? 'on' : ''} onClick={() => { setRun(r); setAsset('all'); }}>{t.agRunF[r]}</button>)}
        </div>
        <div className="coin-switch has-pill" role="tablist" aria-label={t.agAsset}>
          <SlidePill dep={`${run}-${asset}`} />
          {assets.map((b) => <button key={b} role="tab" aria-selected={asset === b} className={asset === b ? 'on' : ''} onClick={() => setAsset(b)}>{b === 'all' ? t.agAll : b}</button>)}
        </div>
        <div className="coin-switch has-pill" role="tablist" aria-label={t.agStyleLabel}>
          <SlidePill dep={style} />
          {(['all', 'trend', 'revert', 'collect'] as StyleF[]).map((s) => <button key={s} role="tab" aria-selected={style === s} className={style === s ? 'on' : ''} onClick={() => setStyle(s)}>{t.agStyle[s]}</button>)}
        </div>
        <label className="ag-sort">
          <span className="muted">{t.agSortLabel}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {(['sharpe', 'total', 'dd'] as Sort[]).map((s) => <option key={s} value={s}>{t.agSort[s]}</option>)}
          </select>
        </label>
      </div>

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
                <span className="ag-rank-name">{agentName(t, a)}</span>
                <span className="ag-rank-v">{a.sharpe.toFixed(2)}</span>
              </li>
            ))}
        </ol>
      </section>

      {failed && <p className="muted">{t.agFailed}</p>}
      <div className="ag-grid stagger" key={`${run}-${asset}-${style}-${sort}`}>
        {!agents && !failed && [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="ag-card ag-skel skel-block" />)}
        {shown.map((a) => (
          <AgentCard key={a.id} agent={a} size="market" starred={stars.has(a.id)} onStar={() => star(a.id)} onHire={() => onHire(a)} onAsk={() => onAsk(a)} />
        ))}
      </div>
      <p className="muted small">{t.agFoot}</p>
    </div>
  );
}
