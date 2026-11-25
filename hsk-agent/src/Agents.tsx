// Agent market: every agent Moa scores, laid out like a gallery (one row of filter chips, then cards).
// It shows; it does not run anything. "Hire" opens the hire sheet over this page, "Ask Moa" hands the card
// to the conversation on the right, "Get a pick from Moa" asks Moa to choose. None of them leave the page.
// Agents for coins without an HSKSwap pool stay listed as "Signal only" (a demo); the page opens on the
// agents you can hire.
import { useMemo, useState } from 'react';
import { useT } from './i18n.ts';
import { type Agent } from './agents.ts';
import { SlidePill } from './motion.tsx';
import { AgentCard } from './AgentCard.tsx';

type Sort = 'sharpe' | 'total' | 'dd';
type StyleF = 'all' | 'trend' | 'revert' | 'collect';
type RunF = 'run' | 'signal' | 'all';

function readStars(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('moa.stars') ?? '[]') as string[]); } catch { return new Set(); }
}

export default function Agents({ agents, failed, onHire, onAsk, onRecommend }: {
  agents: Agent[] | null; failed: boolean; onHire: (a: Agent) => void; onAsk: (a: Agent) => void; onRecommend: () => void;
}) {
  const { t } = useT();
  const [run, setRun] = useState<RunF>('run');
  const [asset, setAsset] = useState<string>('all');
  const [style, setStyle] = useState<StyleF>('all');
  const [sort, setSort] = useState<Sort>('dd');
  const [stars, setStars] = useState<Set<string>>(readStars);

  const inView = useMemo(() => (agents ?? []).filter((a) => (run === 'all' || a.runnable === (run === 'run'))), [agents, run]);
  const shown = useMemo(() => {
    const xs = inView.filter((a) => (asset === 'all' || a.base === asset) && (style === 'all' || a.style === style));
    return xs.sort((p, q) => (sort === 'sharpe' ? q.sharpe - p.sharpe : sort === 'total' ? q.total - p.total : p.maxDd - q.maxDd));
  }, [inView, asset, style, sort]);
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
        <button className="btn-primary ag-pick" onClick={onRecommend}><span className="orb xs" aria-hidden />{t.barRecommend}</button>
      </header>

      <div className="ag-filters">
        <div className="chip-group has-pill" role="tablist" aria-label={t.agRunLabel}>
          <SlidePill dep={run} />
          {(['run', 'signal', 'all'] as RunF[]).map((r) => <button key={r} role="tab" aria-selected={run === r} className={run === r ? 'on' : ''} onClick={() => { setRun(r); setAsset('all'); }}>{t.agRunF[r]}</button>)}
        </div>
        <div className="chip-group has-pill" role="tablist" aria-label={t.agAsset}>
          <SlidePill dep={`${run}-${asset}`} />
          {assets.map((b) => <button key={b} role="tab" aria-selected={asset === b} className={asset === b ? 'on' : ''} onClick={() => setAsset(b)}>{b === 'all' ? t.agAll : b}</button>)}
        </div>
        <div className="chip-group has-pill" role="tablist" aria-label={t.agStyleLabel}>
          <SlidePill dep={style} />
          {(['all', 'trend', 'revert', 'collect'] as StyleF[]).map((s) => <button key={s} role="tab" aria-selected={style === s} className={style === s ? 'on' : ''} onClick={() => setStyle(s)}>{t.agStyle[s]}</button>)}
        </div>
        <label className="ag-sort">
          <span className="muted">{t.agSortLabel}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {(['dd', 'total', 'sharpe'] as Sort[]).map((s) => <option key={s} value={s}>{t.agSort[s]}</option>)}
          </select>
        </label>
      </div>

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
