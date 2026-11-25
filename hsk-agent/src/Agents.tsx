// Agent market, laid out like AI Studio's home: a large light title, one ask bar (it talks to Moa on the right),
// six start cards, then the gallery with a row of filter chips. It shows; it does not run anything. "Hire" opens
// the hire sheet over this page, "Ask Moa" hands the card to the conversation. None of them leave the page.
// Agents for coins without an HSKSwap pool stay listed as "Signal only" (a demo).
import { useMemo, useRef, useState } from 'react';
import { useT } from './i18n.ts';
import { type Agent, type Style } from './agents.ts';
import { AgentCard } from './AgentCard.tsx';
import { Icon, type IconName } from './Icons.tsx';

type Sort = 'sharpe' | 'total' | 'dd';
type RunF = 'run' | 'signal' | 'all';
const START_ICON: Record<string, IconName> = { pick: 'sparkle', collect: 'collect', trend: 'trend', revert: 'dip', chart: 'chart', mine: 'bot' };

function readStars(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('moa.stars') ?? '[]') as string[]); } catch { return new Set(); }
}

export default function Agents({ agents, failed, onHire, onAsk, onRecommend, onAskMoa, onGo }: {
  agents: Agent[] | null; failed: boolean; onHire: (a: Agent) => void; onAsk: (a: Agent) => void; onRecommend: () => void;
  onAskMoa: (text: string) => void; onGo: (v: 'trade' | 'mine') => void;
}) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [run, setRun] = useState<RunF>('run');
  const [asset, setAsset] = useState<string>('all');
  const [style, setStyle] = useState<'all' | Style>('all');
  const [sort, setSort] = useState<Sort>('dd');
  const [stars, setStars] = useState<Set<string>>(readStars);
  const gallery = useRef<HTMLElement>(null);

  const inView = useMemo(() => (agents ?? []).filter((a) => (run === 'all' || a.runnable === (run === 'run'))), [agents, run]);
  const shown = useMemo(() => {
    const xs = inView.filter((a) => (asset === 'all' || a.base === asset) && (style === 'all' || a.style === style));
    return xs.sort((p, r) => (sort === 'sharpe' ? r.sharpe - p.sharpe : sort === 'total' ? (r.total - r.hold) - (p.total - p.hold) : p.maxDd - r.maxDd));
  }, [inView, asset, style, sort]);
  const assets = inView.map((a) => a.base).filter((b, i, xs) => xs.indexOf(b) === i);

  const star = (id: string) => setStars((cur) => {
    const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem('moa.stars', JSON.stringify([...next])); } catch { /* storage unavailable */ }
    return next;
  });
  const toGallery = (s: Style) => { setRun('run'); setAsset('all'); setStyle(s); gallery.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const start = (k: string) => {
    if (k === 'pick') onRecommend();
    else if (k === 'collect' || k === 'trend' || k === 'revert') toGallery(k);
    else if (k === 'chart') onGo('trade');
    else onGo('mine');
  };
  const chip = (label: string, on: boolean, act: () => void) => <button key={label} className={`fchip${on ? ' on' : ''}`} aria-pressed={on} onClick={act}>{label}</button>;

  return (
    <div className="page agents-page studio-home">
      <section className="home-hero">
        <h1>{t.homeTitle}</h1>
        <form className="home-ask" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { onAskMoa(q.trim()); setQ(''); } }}>
          <Icon name="search" />
          <input id="home-ask" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.homeAsk} aria-label={t.homeAsk} autoComplete="off" />
          <button type="submit" className="run-btn" disabled={!q.trim()}>{t.ask}<kbd>↵</kbd></button>
        </form>
      </section>

      <section>
        <div className="home-sec">{t.homeStart}</div>
        <div className="start6 stagger">
          {t.starts.map((s) => (
            <button key={s.k} className="start6-card" onClick={() => start(s.k)}>
              <span className="start6-ic"><Icon name={START_ICON[s.k]} size={18} /></span>
              <b>{s.title}</b>
              <small>{s.sub}</small>
            </button>
          ))}
        </div>
      </section>

      <section ref={gallery} className="home-gallery">
        <div className="fchips">
          {chip(t.agRunF.run, run === 'run', () => { setRun('run'); setAsset('all'); })}
          {chip(t.agRunF.signal, run === 'signal', () => { setRun('signal'); setAsset('all'); })}
          {chip(t.agRunF.all, run === 'all', () => { setRun('all'); setAsset('all'); })}
          <span className="fchips-sep" aria-hidden />
          {chip(t.agAll, asset === 'all', () => setAsset('all'))}
          {assets.map((b) => chip(b, asset === b, () => setAsset(b)))}
          <span className="fchips-sep" aria-hidden />
          {(['trend', 'revert', 'collect'] as Style[]).map((s) => chip(t.agStyle[s], style === s, () => setStyle(style === s ? 'all' : s)))}
          <label className="ag-sort">
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t.agSortLabel}>
              {(['dd', 'total', 'sharpe'] as Sort[]).map((s) => <option key={s} value={s}>{t.agSort[s]}</option>)}
            </select>
          </label>
        </div>
        <h2 className="home-h2">{run === 'run' ? t.homeGallery : run === 'signal' ? t.homeGallerySignal : t.homeGalleryAll}</h2>
        {failed && <p className="muted">{t.agFailed}</p>}
        <div className="ag-grid stagger" key={`${run}-${asset}-${style}-${sort}`}>
          {!agents && !failed && [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="ag-card ag-skel skel-block" />)}
          {shown.map((a) => (
            <AgentCard key={a.id} agent={a} size="market" starred={stars.has(a.id)} onStar={() => star(a.id)} onHire={() => onHire(a)} onAsk={() => onAsk(a)} />
          ))}
        </div>
        <p className="muted small">{t.agFoot}</p>
      </section>
    </div>
  );
}
