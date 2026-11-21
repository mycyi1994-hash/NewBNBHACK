import { useCallback, useEffect, useMemo, useState } from 'react';
import { botName, scheduleOf, type Step } from './intent.ts';
import { fmtPrice, loadQuotes, type Quote } from './market.ts';
import { useBots, useExecutions, type Bot, type Execution } from './store.ts';
import { LangContext, STRINGS, initialLang, saveLang, useT, type Lang, type Strings } from './i18n.ts';
import Trade from './Trade.tsx';
import Assistant, { PlanSteps, type Seed } from './Assistant.tsx';
import { MoaGlyph, coinName, type VaultInfo } from './parts.tsx';

type View = { name: 'trade' } | { name: 'bots' } | { name: 'bot'; id: string };

function useQuotes() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = () => loadQuotes().then((q) => alive && setQuotes(q));
    tick();
    const t = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return quotes;
}

function useVault() {
  const [v, setV] = useState<VaultInfo | null>(null);
  const load = useCallback(() => {
    fetch('/api/vault')
      .then(async (r) => { const j = await r.json(); setV(r.ok ? j : { configured: false, unreachable: true }); })
      .catch(() => setV({ configured: false, unreachable: true }));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  return { vault: v, reloadVault: load };
}

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/* ---------- shell ---------- */

function Logo() {
  return (
    <span className="logo" aria-label="Moa">
      <MoaGlyph size={24} />
      Moa
    </span>
  );
}

function TopNav({ view, go, botCount, quotes }: { view: View; go: (v: View) => void; botCount: number; quotes: Quote[] }) {
  const { t, lang, setLang } = useT();
  const hsk = quotes.find((q) => q.asset === 'HSK');
  const link = (label: string, v: View, active: boolean, badge?: number) => (
    <button className={`nav-link${active ? ' on' : ''}`} onClick={() => go(v)} aria-current={active ? 'page' : undefined}>
      {label}{badge ? <span className="count">{badge}</span> : null}
    </button>
  );
  return (
    <header className="topnav">
      <Logo />
      <nav className="nav-links desktop-only" aria-label="Main">
        {link(t.navTrade, { name: 'trade' }, view.name === 'trade')}
        {link(t.navBots, { name: 'bots' }, view.name !== 'trade', botCount)}
      </nav>
      <div className="nav-right">
        {hsk?.pool !== undefined && <span className="nav-quote"><span>HSK</span>{fmtPrice(hsk.pool)}</span>}
        <span className="status-dot on" title="HSK Chain mainnet"><span className="desktop-only">HSK Chain</span></span>
        <button className="btn-soft sm" onClick={() => setLang(lang === 'en' ? 'ko' : 'en')} aria-label="Switch language">{t.langLabel}</button>
      </div>
    </header>
  );
}

function IconChart() {
  return <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden><path d="M4 3v12M9 5v8M14 2v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><rect x="2.6" y="6" width="2.8" height="5" rx="1" fill="currentColor" /><rect x="7.6" y="7" width="2.8" height="4" rx="1" fill="currentColor" /><rect x="12.6" y="4" width="2.8" height="5" rx="1" fill="currentColor" /></svg>;
}
function IconBots() {
  return <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden><rect x="2.5" y="3" width="13" height="5" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /><rect x="2.5" y="10" width="13" height="5" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /><circle cx="5.5" cy="5.5" r="1" fill="currentColor" /><circle cx="5.5" cy="12.5" r="1" fill="currentColor" /></svg>;
}

function TabBar({ view, go, botCount, moaOpen, openMoa }: { view: View; go: (v: View) => void; botCount: number; moaOpen: boolean; openMoa: () => void }) {
  const { t } = useT();
  return (
    <nav className="tabbar" aria-label="Main">
      <button className={`tab${view.name === 'trade' && !moaOpen ? ' on' : ''}`} onClick={() => go({ name: 'trade' })}><IconChart />{t.navTrade}</button>
      <button className={`tab${moaOpen ? ' on' : ''}`} onClick={openMoa}><MoaGlyph size={17} />Moa</button>
      <button className={`tab${view.name !== 'trade' && !moaOpen ? ' on' : ''}`} onClick={() => go({ name: 'bots' })}><IconBots />{t.navBots}{botCount ? <span className="count">{botCount}</span> : null}</button>
    </nav>
  );
}

/* ---------- bots ---------- */

function botBudget(bot: Bot): number | undefined {
  let total = 0, known = false;
  for (const s of bot.plan.steps) {
    if (s.kind !== 'accumulate') continue;
    const sch = scheduleOf(s);
    if (sch.totalUsd !== undefined) { total += sch.totalUsd; known = true; } else if (s.budgetUsd !== undefined) { total += s.budgetUsd; known = true; }
  }
  return known ? total : undefined;
}
const botAssets = (bot: Bot) => new Set(bot.plan.steps.flatMap((s) => ('asset' in s ? [s.asset] : [])));
const botExecs = (bot: Bot, execs: Execution[]) => execs.filter((x) => x.at >= (bot.since ?? bot.createdAt) && botAssets(bot).has(x.asset as 'HSK'));

function Bots({ bots, go, execs, ask }: { bots: Bot[]; go: (v: View) => void; execs: Execution[]; ask: () => void }) {
  const { t } = useT();
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1>{t.bots}</h1>
          <p className="muted">{t.botsSub}</p>
        </div>
        <button className="btn-primary" onClick={ask}>{t.newBot}</button>
      </div>
      <section className="panel">
        {bots.length ? (
          <table className="grid-table bots-table">
            <thead><tr><th>{t.colBot}</th><th>{t.colGoal}</th><th>{t.colProgress}</th><th className="r">{t.colStatus}</th></tr></thead>
            <tbody>
              {bots.map((b) => {
                const spent = botExecs(b, execs).filter((x) => x.ok && x.side === 'buy').reduce((s, x) => s + x.amount, 0);
                const budget = botBudget(b);
                return (
                  <tr key={b.id} tabIndex={0} onClick={() => go({ name: 'bot', id: b.id })} onKeyDown={(e) => { if (e.key === 'Enter') go({ name: 'bot', id: b.id }); }}>
                    <td className="strong">{b.name}</td>
                    <td className="muted ellipsis">{b.goal}</td>
                    <td className="progress-cell">{budget !== undefined && <span className="mini-bar" aria-hidden><span style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} /></span>}<span>${spent.toFixed(0)}{budget !== undefined ? <span className="muted"> / ${budget.toFixed(0)}</span> : null}</span></td>
                    <td className="r"><StatusChip fills={botExecs(b, execs).filter((x) => x.ok).length} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {bots.length ? <div className="panel-foot muted">{t.botsHint}</div> : (
          <div className="empty">
            <div className="empty-title">{t.noBots}</div>
            <div className="muted">{t.noBotsSub}</div>
            <button className="btn-soft" onClick={ask}>{t.newBot}</button>
          </div>
        )}
      </section>
    </div>
  );
}

const frac = (t: Strings, f: number) => (f === 1 ? t.all : f === 0.5 ? t.half : Math.abs(f - 1 / 3) < 1e-9 ? t.third : `${Math.round(f * 100)}%`);

function StatusChip({ fills }: { fills: number }) {
  const { t } = useT();
  return fills > 0 ? <span className="status manual">{t.manual}</span> : <span className="status draft">{t.draft}</span>;
}

/** Average fill price per asset from successful buys (USDT paid / coins received). */
function avgFill(mine: Execution[], asset: string): number | undefined {
  let paid = 0, got = 0;
  for (const x of mine) if (x.ok && x.side === 'buy' && x.asset === asset) { paid += Number(x.amountIn); got += Number(x.amountOut); }
  return got > 0 ? paid / got : undefined;
}

function BotDetail({ bot, onDelete, execs, vault, back }: { bot: Bot; onDelete: () => void; execs: Execution[]; vault: VaultInfo | null; back: () => void }) {
  const { t } = useT();
  const mine = botExecs(bot, execs).slice().sort((a, b) => a.at - b.at);
  const buys = mine.filter((x) => x.ok && x.side === 'buy');
  const spent = buys.reduce((s, x) => s + x.amount, 0);
  const budget = botBudget(bot);
  const acc = bot.plan.steps.find((s): s is Extract<Step, { kind: 'accumulate' }> => s.kind === 'accumulate');
  const totalBuys = acc ? scheduleOf(acc).buys : undefined;
  const stamp = (at: number) => new Date(at).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const upcoming: string[] = [];
  if (acc?.perBuyUsd !== undefined && (totalBuys === undefined || buys.length < totalBuys)) upcoming.push(t.tlNext(String(acc.perBuyUsd), acc.asset));
  for (const s of bot.plan.steps) {
    if (s.kind !== 'stopLoss' && s.kind !== 'takeProfit') continue;
    const avg = avgFill(mine, s.asset);
    if (s.kind === 'stopLoss') upcoming.push(avg ? t.tlStop(frac(t, s.sellFraction), s.asset, fmtPrice(avg * (1 - s.dropPct / 100)), s.dropPct, fmtPrice(avg)) : t.tlStopWait(s.dropPct));
    else if (avg) upcoming.push(t.tlTp(frac(t, s.sellFraction), s.asset, fmtPrice(avg * (1 + s.risePct / 100)), s.risePct));
  }

  return (
    <div className="page fade-in">
      <button className="back" onClick={back}>← {t.bots}</button>
      <div className="page-head">
        <div>
          <h1>{bot.name} <StatusChip fills={buys.length} /></h1>
          <p className="muted">{t.created} {new Date(bot.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
        </div>
        <button className="btn-soft" onClick={onDelete}>{t.delete}</button>
      </div>
      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel pad-lg">
            <div className="label">{t.goal}</div>
            <p className="goal">“{bot.goal}”</p>
            <div className="label">{t.planSaved}</div>
            <PlanSteps steps={bot.plan.steps} />
          </section>
          <section className="panel">
            <div className="panel-head"><span>{t.timeline}</span></div>
            <ol className="timeline">
              {[...mine.map((x) => ({ at: x.at, x })), { at: bot.createdAt, x: null }].sort((a, b) => a.at - b.at).map(({ x }, i) => {
                if (!x) return <li key="created" className="done"><span className="tl-dot" /><div><b>{t.tlCreated}</b><time>{stamp(bot.createdAt)}</time></div></li>;
                const price = x.ok && Number(x.amountOut) > 0 ? fmtPrice(Number(x.amountIn) / Number(x.amountOut)) : '';
                return (
                  <li key={i} className={x.ok ? 'done' : 'bad'}>
                    <span className="tl-dot" />
                    <div>
                      <b>{x.ok ? t.tlFill(x.side === 'buy' ? t.buy : t.sell, `${Number(x.amountIn).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${coinName(x.tokenIn)}`, `${Number(x.amountOut).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${coinName(x.tokenOut)}`, price) : `${t.notExecuted}: ${x.reason}`}</b>
                      <time>{stamp(x.at)}</time>
                      {x.explorerUrl && <a href={x.explorerUrl} target="_blank" rel="noreferrer">{t.viewTx} {short(x.txHash)} ↗</a>}
                    </div>
                  </li>
                );
              })}
              {upcoming.map((u, i) => <li key={'u' + i} className="next"><span className="tl-dot" /><div><span>{u}</span></div></li>)}
            </ol>
          </section>
        </div>
        <div className="detail-side">
          <section className="panel pad-lg">
            <div className="label">{t.progress}</div>
            <div className="big-num">${spent.toFixed(2)}</div>
            <div className="muted">{budget !== undefined ? t.spent(spent.toFixed(2), budget.toFixed(0)) : t.spentOpen(spent.toFixed(2))}</div>
            {budget !== undefined && <div className="bar" aria-hidden><span style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} /></div>}
            {totalBuys !== undefined && <div className="muted small-text top-gap-sm">{t.buysDone(buys.length, totalBuys)}</div>}
            <p className="muted small-text top-gap">{t.nextRunOff}</p>
          </section>
          <section className="panel">
            <div className="panel-head"><span>{t.limits}</span>{vault?.localFork && <span className="status-dot on" title={t.tipFork}>{t.localFork}</span>}</div>
            {vault?.configured ? (
              <dl className="kv">
                <dt>{t.perTrade}</dt><dd>${vault.maxTradeUsdt}</dd>
                <dt>{t.perDay}</dt><dd>${vault.maxDailyUsdt}</dd>
                <dt>{t.leftToday}</dt><dd>${vault.remainingTodayUsdt}</dd>
                <dt>{t.balance}</dt><dd>{Number(vault.usdtBalance).toFixed(2)} USDT</dd>
              </dl>
            ) : <p className="pad muted small-text">{t.noVault}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

/* ---------- app ---------- */

export default function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => { setLangState(l); saveLang(l); };
  const t = STRINGS[lang];
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const [view, setView] = useState<View>({ name: 'trade' });
  const [moaOpen, setMoaOpen] = useState(false);
  const [seed, setSeed] = useState<Seed | null>(null);
  const quotes = useQuotes();
  const { vault, reloadVault } = useVault();
  const { bots, add, remove } = useBots();
  const { execs, record } = useExecutions();
  const current = useMemo(() => (view.name === 'bot' ? bots.find((b) => b.id === view.id) : undefined), [view, bots]);
  const go = (v: View) => { setView(v); setMoaOpen(false); window.scrollTo(0, 0); };
  const ask = (text = '') => { setSeed((s) => ({ text, n: (s?.n ?? 0) + 1 })); setMoaOpen(true); };

  return (
    <LangContext.Provider value={{ lang, t, setLang }}>
      <div className="app">
        <TopNav view={view} go={go} botCount={bots.length} quotes={quotes} />
        <div className="workspace">
          <main className="main">
            {view.name === 'trade' && <Trade quotes={quotes} vault={vault} />}
            {view.name === 'bots' && <Bots bots={bots} go={go} execs={execs} ask={() => ask()} />}
            {view.name === 'bot' && current && <BotDetail bot={current} execs={execs} vault={vault} back={() => go({ name: 'bots' })} onDelete={() => { remove(current.id); go({ name: 'bots' }); }} />}
          </main>
          <Assistant
            quotes={quotes}
            vault={vault}
            seed={seed}
            open={moaOpen}
            onClose={() => setMoaOpen(false)}
            onExecuted={(x) => { record(x); reloadVault(); }}
            onCreate={(goal, plan, since) => { const b = add({ name: botName(plan), goal, plan, since }); go({ name: 'bot', id: b.id }); return b.id; }}
            onOpen={(id) => go({ name: 'bot', id })}
          />
        </div>
        <TabBar view={view} go={go} botCount={bots.length} moaOpen={moaOpen} openMoa={() => setMoaOpen(true)} />
      </div>
    </LangContext.Provider>
  );
}
