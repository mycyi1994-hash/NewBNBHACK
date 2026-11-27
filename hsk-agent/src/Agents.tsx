// Agent market, in two tabs (after the attached marketplace reference):
//  - Top agents: the ten best equity curves on one chart with a ranked legend, then a ranking table.
//    "Steady" ranks by Sharpe, "Aggressive" by period return. Only agents you can hire are ranked.
//  - Marketplace: search and filters, then one card per agent: the lead number with its equity curve,
//    six readings, and one full-width action.
// It shows; it does not run anything. "Hire" opens the hire sheet over this page, a row or a card title
// hands the agent to Moa on the right. Every number comes from agents.ts; nothing is invented, so there are
// no creators, followers or subscriber counts here.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { SlidePill } from './motion.tsx';
import { StateBox } from './ui.tsx';
import { useT } from './i18n.ts';
import { ACTIVE_DAYS, active, byMerit, idle, type Agent, type Tier, DEMOTED } from './agents.ts';
import { agentName, freshLine, pct, ruleLines, Face } from './AgentCard.tsx';
import { CoinMark } from './CoinMark.tsx';
import { markColor } from './Mark.tsx';
import { Icon, Spark } from './Icons.tsx';

type Tab = 'top' | 'market';
type Rank = 'classic' | 'steady' | 'bold';
type Sort = 'pick' | 'dd' | 'total' | 'sharpe';
const LINE = ['#3b5bdb', '#12b886', '#15aabf', '#f08c00', '#e03131', '#9c36b5', '#868e96', '#f783ac', '#4dabf7', '#fab005'];
const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

function readStars(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('moa.stars') ?? '[]') as string[]); } catch { return new Set(); }
}

/** Equity of the ranked agents over their shared window, as % from the start of that window. */
/**
 * One coin's best agents on one chart, against just holding that coin. Curves of different coins say nothing
 * side by side, so the chart is per coin. Moving over it reads a day: every agent's result then, best first.
 * A flat stretch is the agent sitting in cash; the grey dashed line shows what holding did meanwhile.
 */
function TopChart({ agents, coin, hot, setHot, onOpen }: { agents: Agent[]; coin: string; hot: string | null; setHot: (id: string | null) => void; onOpen: (a: Agent) => void }) {
  const { t, lang } = useT();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 760, rem: 14 });
  const [at, setAt] = useState<number | null>(null);
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
  const u = size.rem / 14, W = size.w, H = Math.round(Math.min(380 * u, Math.max(210 * u, W * 0.36))), L = 46 * u, R = 10 * u, T = 12 * u, B = 26 * u;
  // Everything starts where the youngest curve starts, at zero.
  const from = Math.max(...agents.map((a) => a.equity[0]?.time ?? 0));
  const rebase = (pts: { time: number; value: number }[]) => { const xs = pts.filter((p) => p.time >= from); const base = xs[0]?.value || 1; return xs.map((p) => ({ time: p.time, v: p.value / base - 1 })); };
  const series = agents.map((a) => rebase(a.equity));
  const hold = agents[0] ? rebase(agents[0].bench) : [];
  const all = [...series.flat(), ...hold];
  if (!all.length) return <div className="top-chart" ref={box} />;
  const times = series[0].map((p) => p.time);
  const t0 = times[0], t1 = times[times.length - 1];
  const top = Math.max(0, ...all.map((p) => p.v)), bottom = Math.min(0, ...all.map((p) => p.v));
  const step = [0.1, 0.25, 0.5, 1, 2, 5].find((v) => (top - bottom) / v <= 6) ?? 10;
  const lo = Math.floor(bottom / step) * step, hi = Math.ceil(top / step) * step || step;
  const x = (time: number) => L + ((time - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const marks: number[] = []; for (let v = lo; v <= hi + 1e-9; v += step) marks.push(+v.toFixed(4));
  const path = (pts: { time: number; v: number }[]) => pts.map((p, n) => `${n ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const ticks = [0.08, 0.3, 0.52, 0.74, 0.94].map((f) => t0 + f * (t1 - t0));
  const month = (time: number) => new Date(time * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US', { year: '2-digit', month: 'short', timeZone: 'UTC' });
  const dayText = (time: number) => new Date(time * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const time = t0 + ((px - L) / (W - L - R)) * (t1 - t0);
    let i = 0; for (let k = 1; k < times.length; k++) if (Math.abs(times[k] - time) < Math.abs(times[i] - time)) i = k;
    setAt(i);
    // The line under the pointer is the one in focus.
    let best: string | null = null, gap = 14 * u;
    series.forEach((sr, k) => { const p = sr[Math.min(i, sr.length - 1)]; const d = Math.abs(y(p.v) - py); if (d < gap) { gap = d; best = agents[k].id; } });
    setHot(best);
  };
  const rows = at === null ? [] : [
    ...agents.map((a, k) => ({ id: a.id, name: agentName(t, a), color: LINE[k % LINE.length], v: series[k][Math.min(at, series[k].length - 1)].v, a })),
    { id: 'hold', name: t.topHold(coin), color: '#9aa0a6', v: hold[Math.min(at, hold.length - 1)]?.v ?? 0, a: null as Agent | null },
  ].sort((p, r) => r.v - p.v);
  const cx = at === null ? 0 : x(times[at]);
  return (
    <div className="top-chart" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t.topChart(agents.length)} onMouseMove={move} onMouseLeave={() => { setAt(null); setHot(null); }}
        onClick={() => { const a = agents.find((v) => v.id === hot); if (a) onOpen(a); }} style={{ cursor: hot ? 'pointer' : 'crosshair' }}>
        {marks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis-zero' : 'axis-line'} /><text x={L - 8 * u} y={y(v) + 4 * u} textAnchor="end" className="axis-text">{v > 0 ? '+' : ''}{Math.round(v * 100)}%</text></g>)}
        <path d={path(hold)} fill="none" className="top-hold" strokeWidth={1.5 * u} />
        {[...series].reverse().map((sr, k) => {
          const i = series.length - 1 - k, on = hot === agents[i].id;
          return <path key={agents[i].id} d={path(sr)} fill="none" stroke={LINE[i % LINE.length]} strokeWidth={(on ? 3 : i === 0 ? 2.2 : 1.6) * u} strokeLinejoin="round" opacity={hot && !on ? 0.22 : 1} className="top-line" />;
        })}
        {ticks.map((time, i) => <text key={i} x={x(time)} y={H - 6 * u} textAnchor="middle" className="axis-text">{month(time)}</text>)}
        {at !== null && (
          <g pointerEvents="none">
            <line x1={cx} x2={cx} y1={T} y2={H - B} className="top-guide" />
            {series.map((sr, k) => <circle key={agents[k].id} cx={cx} cy={y(sr[Math.min(at, sr.length - 1)].v)} r={(hot === agents[k].id ? 5 : 3.5) * u} fill={LINE[k % LINE.length]} stroke="#fff" strokeWidth={1.5 * u} opacity={hot && hot !== agents[k].id ? 0.3 : 1} />)}
          </g>
        )}
      </svg>
      {at !== null && (
        <div className={`top-tip${cx > W / 2 ? ' left' : ''}`} style={cx > W / 2 ? { left: L + 6 * u } : { right: R + 6 * u }}>
          <b>{dayText(times[at])}</b>
          {rows.map((r) => <span key={r.id} className={r.id === hot ? 'on' : r.id === 'hold' ? 'hold' : ''}><i style={{ background: r.color }} />{r.name}<em className={sign(r.v)}>{pct(r.v)}</em></span>)}
        </div>
      )}
    </div>
  );
}

/**
 * The card's chart: the agent's money line over just holding the coin (grey, dashed), both from the same start, so
 * the big number above is the gap you can see. A flat stretch is the agent sitting in cash.
 */
function CardChart({ a, up, label }: { a: Agent; up: boolean; label: string }) {
  const W = 200, H = 72;
  const thin = <T,>(xs: T[]) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / 64)) === 0 || i === xs.length - 1);
  const eq = thin(a.equity), bn = thin(a.bench);
  if (eq.length < 2) return null;
  const e0 = eq[0].value || 1, b0 = bn[0]?.value || 1;
  const ev = eq.map((p) => p.value / e0), bv = bn.map((p) => p.value / b0);
  const lo = Math.min(...ev, ...bv), hi = Math.max(...ev, ...bv), span = hi - lo || 1;
  const line = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${((i / (vs.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - lo) / span) * (H - 8)).toFixed(1)}`).join('');
  const d = line(ev);
  return (
    <figure className="mp-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className={up ? 'up' : 'down'}>
        {bv.length > 1 && <path className="hold" d={line(bv)} fill="none" vectorEffect="non-scaling-stroke" />}
        <path className="area" d={`${d}L${W},${H}L0,${H}Z`} />
        <path className="draw line" pathLength={1} d={d} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption><i aria-hidden />{label}</figcaption>
    </figure>
  );
}

/** One agent in the ranking: rank, mark, name and plain line, freshness, and the one number. */
function TopRow({ a, n, onOpen }: { a: Agent; n?: number; onOpen: (a: Agent) => void }) {
  const { t } = useT();
  const edge = a.total - a.hold;
  const fresh = freshLine(t, a);
  return (
    <li>
      <button className={`tp-row${n && n <= 3 ? ` medal-${n}` : ''}`} onClick={() => onOpen(a)} style={{ '--fam': markColor(a.rule) } as CSSProperties}>
        <span className="tp-n">{n ? (n <= 3 ? <Icon name="medal" size={18} /> : n) : ''}</span>
        <Face rule={a.rule} base={a.base} size="lg" />
        <span className="tp-main">
          <b>{agentName(t, a)}</b>
          <span className="tp-plain">{a.made ? ruleLines(t, a)[0] : t.agPlain[a.rule]}</span>
          <span className={`tp-fresh${fresh.on ? ' on' : ''}`}><i aria-hidden />{fresh.text}</span>
        </span>
        <span className="tp-num"><small>{t.mpVsHold}</small><b className={sign(edge)}>{pct(edge)}</b><span>{t.mpOver(a.days)}</span></span>
        <span className="tp-go" aria-hidden><Icon name="chevron" size={18} /></span>
      </button>
    </li>
  );
}

/** One card in the marketplace: the mark, the name, one plain line, one number with its chart, two actions. */
function MarketCard({ a, big, starred, onStar, onOpen, onHire }: { a: Agent; big?: boolean; starred: boolean; onStar: () => void; onOpen: (a: Agent) => void; onHire: (a: Agent) => void }) {
  const { t } = useT();
  const fresh = freshLine(t, a);
  const edge = a.total - a.hold;
  // The source in a few words: the year for a published classic, otherwise what kind of rule it is.
  // The full source stays one hover away, and in the backtest.
  const year = a.tier === 1 ? /\b(1[89]|20)\d{2}\b/.exec(t.agOrigin[a.rule])?.[0] : undefined;
  return (
    <article className={`mp-card${big ? ' big' : ''}${a.runnable ? '' : ' signal-only'}`} style={{ '--fam': markColor(a.rule) } as CSSProperties}>
      <header className="mp-top">
        <button className="mp-title" onClick={() => onOpen(a)}>
          <Face rule={a.rule} base={a.base} size="xl" />
          <span className="mp-name">
            <b>{agentName(t, a)}</b>
            <span className="mp-sub">
              <span className={`mp-origin tip-tap tier-${a.tier}`} tabIndex={0} role="note" aria-label={t.agOrigin[a.rule]} data-tip={t.agOrigin[a.rule]}>{a.tier === 1 && <i aria-hidden>★</i>}{year ? t.mpSince(year) : t.agTier[a.tier]}<svg className="mp-i" width="13" height="13" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7.2v3.6M8 5.2v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></span>
              <span className={`mp-live${fresh.on ? ' on' : ''}`}><i aria-hidden />{fresh.text}</span>
            </span>
          </span>
        </button>
        <button className={`mp-star${starred ? ' on' : ''}`} onClick={onStar} aria-pressed={starred} aria-label={t.agStar} data-tip={t.agStar}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><path d="M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2L2.5 8l5.2-.7L10 2.5z" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
        </button>
      </header>
      <p className="mp-plain">{a.made ? ruleLines(t, a)[0] : t.agPlain[a.rule]}</p>
      <div className="mp-result">
        <div className="mp-num">
          <small>{t.mpVsHold}</small>
          <b className={sign(edge)}>{pct(edge)}</b>
          <span>{t.mpOver(a.days)}</span>
        </div>
        <CardChart a={a} up={edge >= 0} label={t.mpHoldLine} />
      </div>
      <footer className="mp-foot">
        <button className="mp-run ghost" onClick={() => onOpen(a)}>{t.mpMore}</button>
        <button className="mp-run" onClick={() => onHire(a)}>{t.acHire}</button>
      </footer>
    </article>
  );
}
/**
 * The ranking beside the marketplace, one coin at a time. The order is byMerit: agents working now first, then the
 * ones that beat just holding. It says nothing about how many people use an agent: there is no such data.
 */
function Rail({ agents, coins, onOpen }: { agents: Agent[]; coins: string[]; onOpen: (a: Agent) => void }) {
  const { t } = useT();
  const [coin, setCoin] = useState('BTC');
  const on = coins.includes(coin) ? coin : coins[0] ?? coin;
  const rows = useMemo(() => agents.filter((a) => a.base === on && !DEMOTED.has(a.rule)).sort(byMerit).slice(0, 10), [agents, on]);
  return (
    <aside className="mp-rail" aria-label={t.mpRankTitle}>
      <header className="mp-rail-head">
        <b>{t.mpRankTitle}</b>
        <small>{t.mpRankSub}</small>
        <div className="mp-coins sm" role="group" aria-label={t.fAsset}>
          {coins.map((c) => <button key={c} className={on === c ? 'on' : ''} aria-pressed={on === c} onClick={() => setCoin(c)}><CoinMark base={c} />{c}</button>)}
        </div>
      </header>
      <ol className="mp-rank">
        {!agents.length && [0, 1, 2, 3, 4].map((i) => <li key={i} className="mp-rank-skel skel-block" />)}
        {rows.map((a, i) => {
          const edge = a.total - a.hold;
          return (
            <li key={a.id}>
              <button onClick={() => onOpen(a)}>
                <span className={`mp-rank-n${i < 3 ? ' top' : ''}`}>{i + 1}</span>
                <Face rule={a.rule} size="sm" />
                <span className="mp-rank-name"><b>{a.made?.name ?? t.agNick[a.rule]}</b>{a.interval && <small className="mp-rank-iv">{t.ivTag[a.interval]}</small>}{active(a) && <i className="mp-rank-live" aria-hidden />}</span>
                <span className={`mp-rank-v ${sign(edge)}`}>{pct(edge)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mp-rail-foot"><span><i className="mp-rank-live" aria-hidden />{t.mpRankLive}</span><span>{t.mpRankNum}</span></p>
    </aside>
  );
}

export default function Agents({ agents, failed, onRetry, onHire, onOpen, onRecommend }: {
  agents: Agent[] | null; failed: boolean; onRetry: () => void; onHire: (a: Agent) => void; onOpen: (a: Agent) => void; onRecommend: () => void;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('top');
  const [rank, setRank] = useState<Rank>('classic');
  const [coin, setCoin] = useState('BTC');
  const [hot, setHot] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [asset, setAsset] = useState('all');
  const [origin, setOrigin] = useState<'all' | '1' | '2' | '3'>('all');
  const [sort, setSort] = useState<Sort>('pick');
  const [stars, setStars] = useState<Set<string>>(readStars);

  const runnable = useMemo(() => (agents ?? []).filter((a) => a.runnable), [agents]);
  // "Published classics" is the first tab: only strategies with a public record, best risk-adjusted result first.
  // One coin at a time: curves and ranks of different coins do not compare.
  const coins = useMemo(() => ['BTC', 'ETH', 'HSK'].filter((c) => runnable.some((a) => a.base === c)), [runnable]);
  const board = coins.includes(coin) ? coin : coins[0] ?? coin;
  // "Published classics" is the first tab: only strategies with a public record, best risk-adjusted result first.
  const ranked = useMemo(() => runnable.filter((a) => a.base === board && a.kind === 'position' && (rank === 'classic' ? a.tier === 1 : !DEMOTED.has(a.rule)))
    .sort((p, r) => Number(!active(p)) - Number(!active(r)) || Number(idle(p)) - Number(idle(r)) || (rank === 'bold' ? r.total - p.total : r.sharpe - p.sharpe)), [runnable, rank, board]);
  // The chart draws curves over one shared stretch of time, so it holds agents scored over the same window as the
  // leader (three years of daily candles, or the short-term agents' hourly / 4-hour windows); the list keeps them all.
  const top = ranked.filter((a) => (a.interval ?? '1d') === (ranked[0]?.interval ?? '1d')).slice(0, 6);
  const working = useMemo(() => ranked.filter((a) => active(a)), [ranked]);
  const resting = useMemo(() => ranked.filter((a) => !active(a)), [ranked]);
  const assets = useMemo(() => runnable.map((a) => a.base).filter((b, i, xs) => xs.indexOf(b) === i), [runnable]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // Only agents that can be hired; a coin without an HSKSwap pool shows its signal-only agents on its own chart.
    const xs = runnable.filter((a) => (asset === 'all' || a.base === asset) && (origin === 'all' || String(a.tier) === origin)
      && (!needle || agentName(t, a).toLowerCase().includes(needle)));
    return xs.sort((p, r) => (sort === 'pick' ? byMerit(p, r) : sort === 'sharpe' ? r.sharpe - p.sharpe : sort === 'total' ? r.total - p.total : p.maxDd - r.maxDd));
  }, [runnable, q, asset, sort, origin, t]);

  // Lead with the two agents doing best right now (the default order), but only on the unfiltered view.
  const plain = !q.trim() && asset === 'all' && origin === 'all' && sort === 'pick';
  // The research's demoted classics sit in their own group at the end, out of the default order.
  const lead = shown.filter((a) => !DEMOTED.has(a.rule)), classic = shown.filter((a) => DEMOTED.has(a.rule));
  const feat = plain ? lead.slice(0, 2) : [];
  const rest = plain ? lead.slice(2) : lead;
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
          <div className="rank-bar">
            <div className="rank-tabs has-line" role="tablist">
              <SlidePill dep={rank} />
              {(['classic', 'steady', 'bold'] as Rank[]).map((k) => <button key={k} role="tab" aria-selected={rank === k} className={rank === k ? 'on' : ''} onClick={() => setRank(k)}>{k === 'classic' ? t.topClassic : k === 'steady' ? t.topSteady : t.topBold}</button>)}
            </div>
            <div className="seg" role="group" aria-label={t.topCoin}>
              {coins.map((c) => <button key={c} className={board === c ? 'on' : ''} aria-pressed={board === c} onClick={() => setCoin(c)}>{c}</button>)}
            </div>
          </div>

          <section className="top-panel">
            <div className="top-main">
              <div className="top-title">{t.topChart(top.length || 10)} <small>{t.topChartSub}</small></div>
              {agents ? <TopChart key={`${rank}-${board}`} agents={top} coin={board} hot={hot} setHot={setHot} onOpen={onOpen} /> : <div className="top-skel skel-block" />}
              <p className="top-foot">{t.topFlat} {t.topPick}</p>
            </div>
            <div className="top-legend">
              <div className="top-legend-head"><span>{t.topLegendA}</span><span>{top[0] ? t.topLegendB(top[0].days) : ''}</span></div>
              <ol>
                {(agents ? top : Array.from({ length: 6 }, (_, i) => i)).map((a, i) => typeof a === 'number'
                  ? <li key={i}><span className="skel" style={{ width: '70%' }} /></li>
                  : (
                    <li key={a.id} className={hot === a.id ? 'on' : hot ? 'dim' : ''}>
                      <button onClick={() => onOpen(a)} onMouseEnter={() => setHot(a.id)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(a.id)} onBlur={() => setHot(null)}>
                        <span className="lg-n">{i + 1}</span>
                        <i style={{ background: LINE[i % LINE.length] }} />
                        <span className="lg-name">{agentName(t, a)}</span>
                        <span className={`lg-v ${sign(a.total)}`}>{pct(a.total)}</span>
                      </button>
                    </li>
                  ))}
                {agents && top[0] && <li className="lg-hold"><span><span className="lg-n" /><i /><span className="lg-name">{t.topHold(board)}</span><span className={`lg-v ${sign(top[0].hold)}`}>{pct(top[0].hold)}</span></span></li>}
              </ol>
            </div>
          </section>

          {/* The ranking in plain words: who, what it does, when it last did something, and one number against just
              holding. Agents that have done nothing for a month fold away at the bottom. */}
          <ol className="tp-list" aria-label={t.mpTabTop}>
            {!agents && !failed && [0, 1, 2, 3, 4].map((i) => <li key={i} className="tp-skel skel-block" />)}
            {working.map((a, i) => <TopRow key={a.id} a={a} n={i + 1} onOpen={onOpen} />)}
          </ol>
          {agents && !working.length && <p className="muted">{t.mpNone}</p>}
          {resting.length > 0 && (
            <details className="tp-rest">
              <summary><span>{t.topRest(resting.length)}</span><small>{t.topRestSub(ACTIVE_DAYS)}</small><Icon name="chevron" size={16} /></summary>
              <ol className="tp-list quiet">{resting.map((a) => <TopRow key={a.id} a={a} onOpen={onOpen} />)}</ol>
            </details>
          )}
          <p className="muted small">{t.topNote(runnable.length)} {t.agFoot}</p>
        </>
      )}

      {!failed && tab === 'market' && (
        <>
          <div className="mp-filters">
            <label className="mp-search"><Icon name="search" size={18} /><input id="mp-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.mpSearch} aria-label={t.mpSearch} autoComplete="off" /></label>
            <div className="mp-coins" role="group" aria-label={t.fAsset}>
              {['all', ...assets].map((b) => (
                <button key={b} className={asset === b ? 'on' : ''} aria-pressed={asset === b} onClick={() => setAsset(b)}>
                  {b !== 'all' && <CoinMark base={b} />}{b === 'all' ? t.mpAll : b}
                </button>
              ))}
            </div>
            <span className="mp-pick">
              <select value={origin} onChange={(e) => setOrigin(e.target.value as 'all' | '1' | '2' | '3')} aria-label={t.fOrigin}>
                <option value="all">{t.fOrigin}</option>
                {([1, 2, 3] as Tier[]).map((k) => <option key={k} value={String(k)}>{t.agTier[k]}</option>)}
              </select>
            </span>
            <span className="mp-pick sort">
              <svg className="mp-pick-ic" width="16" height="16" viewBox="0 0 20 20" aria-hidden><path d="M6 4v12M3 13l3 3 3-3M14 16V4M11 7l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t.fSort}>
                {(['pick', 'dd', 'total', 'sharpe'] as Sort[]).map((k) => <option key={k} value={k}>{k === 'pick' ? t.sortPick : t.agSort[k]}</option>)}
              </select>
            </span>
          </div>

          <div className="mp-layout">
            <div className="mp-mainc">
              {feat.length > 0 && (
                <section className="mp-sec" aria-label={t.mpFeatured}>
                  <h2 className="mp-h2">{t.mpFeatured}</h2>
                  <div className="mp-grid feat stagger">{feat.map((a) => <MarketCard key={a.id} a={a} big starred={stars.has(a.id)} onStar={() => star(a.id)} onOpen={onOpen} onHire={onHire} />)}</div>
                </section>
              )}
              <section className="mp-sec" aria-label={t.mpAllHead}>
                {feat.length > 0 && <h2 className="mp-h2">{t.mpAllHead}</h2>}
                <div className="mp-grid stagger" key={`${asset}-${sort}-${origin}`}>
                  {!agents && !failed && [0, 1, 2, 3].map((i) => <div key={i} className="mp-card mp-skel skel-block" />)}
                  {rest.map((a) => <MarketCard key={a.id} a={a} starred={stars.has(a.id)} onStar={() => star(a.id)} onOpen={onOpen} onHire={onHire} />)}
                </div>
              </section>
              {classic.length > 0 && (
                <details className="mp-sec mp-classic">
                  <summary><h2 className="mp-h2">{t.mpClassic} <small>{classic.length}</small></h2><span>{t.mpClassicSub}</span><Icon name="down" size={16} /></summary>
                  <div className="mp-grid">{classic.map((a) => <MarketCard key={a.id} a={a} starred={stars.has(a.id)} onStar={() => star(a.id)} onOpen={onOpen} onHire={onHire} />)}</div>
                </details>
              )}
            </div>
            <Rail agents={runnable} coins={coins} onOpen={onOpen} />
          </div>
          {agents && !shown.length && <p className="muted">{t.mpNone}</p>}
          <p className="muted small">{t.agFoot}</p>
        </>
      )}
    </div>
  );
}
