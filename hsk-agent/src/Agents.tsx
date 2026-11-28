// Agent market, in three tabs:
//  - At a glance: one coin at a time, every agent grouped by how it did in the period on screen (Moa's pick, better
//    than holding, calmer, classics, behind holding, lab), with just holding as the last row of each group. No ranks.
//  - Marketplace: search and coin, then one card per agent in the same groups. A card says the agent's own result as
//    money, just holding's under it, and three marks for "did it beat holding" over 3달, 1년 and 3년 (src/Perf.tsx).
//  - Made by people: agents other people made and shared (src/Shared.tsx).
// One period switch (3달 / 1년 / 3년) applies to every card and row on the page. It shows; it does not run anything.
// "Hire" opens the hire sheet over this page; a row or a card title hands the agent to Moa on the right. Every
// number comes from each agent's own curves; nothing is invented, so there are no followers or subscriber counts.
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { SlidePill } from './motion.tsx';
import { StateBox } from './ui.tsx';
import { useT } from './i18n.ts';
import { AiSection } from './AiPanel.tsx';
import { type Agent } from './agents.ts';
import { agentName, ruleLines, Face } from './AgentCard.tsx';
import { CoinMark } from './CoinMark.tsx';
import { markColor } from './Mark.tsx';
import { Icon, Spark } from './Icons.tsx';
import { SharedMarket } from './Shared.tsx';
import { AgentRow, AsOf, byTier, FOLDED, HoldRow, MoneyHero, PeriodMarks, PeriodSwitch, usePeriod, won, stakeOf, periodResult, type PeriodDays, type ListTier } from './Perf.tsx';

type Tab = 'top' | 'market' | 'people';

function readStars(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('moa.stars') ?? '[]') as string[]); } catch { return new Set(); }
}

/**
 * The card's chart over the period on screen: the agent's money line over just holding the coin (grey, dashed), both
 * from the same start. A flat stretch is the agent sitting in cash.
 */
function CardChart({ a, days }: { a: Agent; days: PeriodDays }) {
  const W = 200, H = 64;
  const from = (a.equity[a.equity.length - 1]?.time ?? 0) - days * 86_400;
  const cut = <T extends { time: number }>(xs: T[]) => xs.filter((p) => p.time >= from);
  const thin = <T,>(xs: T[]) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / 64)) === 0 || i === xs.length - 1);
  const eq = thin(cut(a.equity)), bn = thin(cut(a.bench));
  if (eq.length < 2) return <div className="mc-chart" />;
  const e0 = eq[0].value || 1, b0 = bn[0]?.value || 1;
  const ev = eq.map((p) => p.value / e0), bv = bn.map((p) => p.value / b0);
  const lo = Math.min(...ev, ...bv), hi = Math.max(...ev, ...bv), span = hi - lo || 1;
  const line = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${((i / (vs.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - lo) / span) * (H - 8)).toFixed(1)}`).join('');
  const d = line(ev);
  return (
    <div className="mc-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className={ev[ev.length - 1] >= 1 ? 'up' : 'down'}>
        {bv.length > 1 && <path className="hold" d={line(bv)} fill="none" vectorEffect="non-scaling-stroke" />}
        <path className="area" d={`${d}L${W},${H}L0,${H}Z`} />
        <path className="draw line" pathLength={1} d={d} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/**
 * One card: who and what (name, one line), the agent's money for the period with just holding's under it, the curve,
 * three marks against holding, and two actions. Two numbers, three marks, a few words.
 */
function MarketCard({ a, period, starred, onStar, onOpen, onHire }: { a: Agent; period: PeriodDays; starred: boolean; onStar: () => void; onOpen: (a: Agent) => void; onHire: (a: Agent) => void }) {
  const { t } = useT();
  return (
    <article className={`mc${a.runnable ? '' : ' signal-only'}`} style={{ '--fam': markColor(a.rule) } as CSSProperties}>
      <header className="mc-top">
        <button className="mc-title" onClick={() => onOpen(a)}>
          <Face rule={a.rule} base={a.base} size="lg" />
          <span className="mc-name"><b>{agentName(t, a)}</b><small>{a.made ? ruleLines(t, a)[0] : t.agPlain[a.rule]}</small></span>
        </button>
        <button className={`mp-star${starred ? ' on' : ''}`} onClick={onStar} aria-pressed={starred} aria-label={t.agStar} data-tip={t.agStar}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><path d="M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2L2.5 8l5.2-.7L10 2.5z" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
        </button>
      </header>
      <div className="mc-body">
        <MoneyHero a={a} period={period} />
        <CardChart a={a} days={period} />
      </div>
      <div className="mc-strip">
        <PeriodMarks a={a} active={period} />
        {a.live && a.kind === 'position' && <span className="mc-live"><i aria-hidden />{t.frHolding}</span>}
      </div>
      <footer className="mc-foot">
        <button className="mp-run ghost" onClick={() => onOpen(a)}>{t.mpMore}</button>
        <button className="mp-run" onClick={() => onHire(a)} disabled={!a.runnable}>{t.acHire}</button>
      </footer>
    </article>
  );
}

/** Just holding each coin for the period on screen, the line every card is read against. */
function HoldStrip({ list, period }: { list: Agent[]; period: PeriodDays }) {
  const { t, lang } = useT();
  const coins = [...new Set(list.map((a) => a.base))];
  const rows = coins.map((c) => ({ c, r: list.filter((a) => a.base === c).map((a) => periodResult(a, period)).find((x) => x) })).filter((x) => x.r);
  if (!rows.length) return null;
  return (
    <p className="mc-holdstrip">
      <span>{t.pfIf(t.pfName[period], won(lang, stakeOf(lang)))}</span>
      {rows.map(({ c, r }) => <b key={c}><CoinMark base={c} />{t.pfHoldName(c)} {won(lang, stakeOf(lang) * (1 + r!.hold))}</b>)}
    </p>
  );
}

/** A tier heading with its one line, open or folded. */
function TierBlock({ tier, n, children }: { tier: ListTier; n: number; children: ReactNode }) {
  const { t } = useT();
  const head = <><h2 className="mp-h2" data-tip={t.tierWhy[tier]}>{t.tierName[tier]} <small>{n}</small></h2><span className="mp-tier-sub">{t.pfTierSub[tier]}</span></>;
  return FOLDED.has(tier)
    ? <details className={`mp-sec tier-${tier}`}><summary>{head}<Icon name="down" size={16} /></summary>{children}</details>
    : <section className={`mp-sec tier-${tier}`}><div className="mp-sec-head">{head}</div>{children}</section>;
}

export default function Agents({ agents, failed, onRetry, onHire, onOpen, onRecommend, onBuild, startTab, at }: {
  agents: Agent[] | null; failed: boolean; onRetry: () => void; onHire: (a: Agent) => void; onOpen: (a: Agent) => void; onRecommend: () => void;
  onBuild: () => void; startTab?: Tab;
  /** When the list was scored (ms, from the server's cache), for "5분 전 기준". */
  at?: number | null;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>(startTab ?? 'top');
  const [period, setPeriod] = usePeriod();
  const [coin, setCoin] = useState('BTC');
  const [q, setQ] = useState('');
  const [asset, setAsset] = useState('all');
  const [stars, setStars] = useState<Set<string>>(readStars);

  const runnable = useMemo(() => (agents ?? []).filter((a) => a.runnable), [agents]);
  const coins = useMemo(() => ['BTC', 'ETH', 'HSK'].filter((c) => runnable.some((a) => a.base === c)), [runnable]);
  const board = coins.includes(coin) ? coin : coins[0] ?? coin;
  const assets = coins;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return runnable.filter((a) => (asset === 'all' || a.base === asset) && (!needle || agentName(t, a).toLowerCase().includes(needle)));
  }, [runnable, q, asset, t]);
  const groups = useMemo(() => byTier(shown), [shown]);
  const glance = useMemo(() => byTier(runnable.filter((a) => a.base === board)), [runnable, board]);
  const holdOf = (list: Agent[]) => list.find((a) => periodResult(a, period));
  const star = (id: string) => setStars((cur) => {
    const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem('moa.stars', JSON.stringify([...next])); } catch { /* storage unavailable */ }
    return next;
  });
  // No agent earns "ahead" under the label rule today: say so once, calmly, instead of an empty section.
  const noneAhead = (gs: { tier: ListTier }[]) => agents && gs.length > 0 && !gs.some((g) => g.tier === 'ahead') ? <p className="mp-empty">{t.pfNoneAhead}</p> : null;

  return (
    <div className="page market-page">
      <nav className="subnav has-line" aria-label={t.agTitle}>
        <SlidePill dep={tab} />
        {(['top', 'market', 'people'] as Tab[]).map((k) => <button key={k} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{k === 'top' ? t.pfAllHead : k === 'market' ? t.mpTabMarket : t.shTab}</button>)}
      </nav>

      <header className="mp-head">
        <h1>{tab === 'top' ? t.pfAllHead : tab === 'people' ? t.shHead : t.mpTitle}</h1>
        <button className="btn-dark" onClick={onRecommend}><Spark size={14} />{t.barRecommend}</button>
      </header>

      {failed && tab !== 'people' && <StateBox title={t.errAgents} text={t.agFailed} retry={t.retry} onRetry={onRetry} />}
      {tab === 'people' && <SharedMarket onOpen={onOpen} onHire={onHire} onBuild={onBuild} />}

      {!failed && tab === 'top' && (
        <>
          <div className="mp-filters">
            <div className="mp-coins" role="group" aria-label={t.topCoin}>
              {coins.map((c) => <button key={c} className={board === c ? 'on' : ''} aria-pressed={board === c} onClick={() => setCoin(c)}><CoinMark base={c} />{c}</button>)}
            </div>
            <PeriodSwitch value={period} onChange={setPeriod} />
            <AsOf at={at} t={t} />
          </div>
          <p className="mp-lead">{t.pfAllSub}</p>
          {/* Moa AI sits apart from the tiers: it has no backtest, only its record from the first decision. */}
          <AiSection onHire={onHire} coin={board} />
          {!agents && <ol className="tp-list">{[0, 1, 2, 3, 4].map((i) => <li key={i} className="tp-skel skel-block" />)}</ol>}
          {noneAhead(glance)}
          {glance.map((g) => (
            <TierBlock key={g.tier} tier={g.tier} n={g.agents.length}>
              <ol className="tp-list">
                {g.agents.map((a) => <AgentRow key={a.id} a={a} period={period} onOpen={() => onOpen(a)} />)}
                <HoldRow coin={board} a={holdOf(g.agents)} period={period} />
              </ol>
            </TierBlock>
          ))}
          <p className="muted small">{t.agFoot}</p>
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
            <PeriodSwitch value={period} onChange={setPeriod} />
            <AsOf at={at} t={t} />
          </div>
          <HoldStrip list={shown} period={period} />
          {!q.trim() && <AiSection onHire={onHire} coin={asset === 'all' ? undefined : asset} />}
          {!agents && <div className="mp-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="mc mp-skel skel-block" />)}</div>}
          {!q.trim() && noneAhead(groups)}
          {groups.map((g) => (
            <TierBlock key={g.tier} tier={g.tier} n={g.agents.length}>
              <div className="mp-grid stagger">{g.agents.map((a) => <MarketCard key={a.id} a={a} period={period} starred={stars.has(a.id)} onStar={() => star(a.id)} onOpen={onOpen} onHire={onHire} />)}</div>
            </TierBlock>
          ))}
          {agents && !shown.length && <p className="mp-empty">{t.mpNone}</p>}
          <p className="muted small">{t.agFoot}</p>
        </>
      )}
    </div>
  );
}
