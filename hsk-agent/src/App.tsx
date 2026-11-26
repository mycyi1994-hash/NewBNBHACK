// The shell. Three screens (trade, agent market, my agents), the "My agents" bar on top of all of them,
// and one Moa conversation docked on the right of all of them. On small screens Moa slides up as a sheet.
// The agent market shows, Moa picks and explains, hired agents work:
//  - the hire sheet is the only place amounts change
//  - the runner below decides each hired agent's next order from its rule, and every order waits for the
//    user's OK in Moa's conversation before it goes to the vault (which enforces its limits again)
//  - pausing works from the bar without Moa or the AI
import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtPrice, loadQuotes, type Quote } from './market.ts';
import { useExecutions, useHired } from './store.ts';
import { LangContext, STRINGS, initialLang, saveLang, useT, type Lang } from './i18n.ts';
import { RollNum } from './motion.tsx';
import { Icon, type IconName } from './Icons.tsx';
import Trade, { type ShowAgent } from './Trade.tsx';
import Agents from './Agents.tsx';
import MyAgents from './MyAgents.tsx';
import MyAgentsBar from './MyAgentsBar.tsx';
import MoaFeed, { type MoaAsk, type MoaContext, type MoaInject } from './MoaFeed.tsx';
import HireSheet, { type HireTarget } from './HireSheet.tsx';
import { agentById, loadAgents, type Agent } from './agents.ts';
import type { Asset } from './intent.ts';
import { chainNote, decide, newId, type Amounts, type HiredAgent, type Signal } from './runner.ts';
import { hiredName } from './hiredText.ts';
import { agentName } from './AgentCard.tsx';
import { sendAgentTrade } from './moaClient.ts';
import type { VaultInfo } from './parts.tsx';
import { ToastProvider, useToast } from './ui.tsx';

type View = 'trade' | 'agents' | 'mine';
const NARROW = '(max-width: 1180px)';

function useQuotes() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = () => loadQuotes().then((q) => alive && setQuotes(q)).catch(() => undefined);
    tick();
    const t = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return quotes;
}

function useVault() {
  const [v, setV] = useState<VaultInfo | null>(null);
  const load = useCallback(() => { fetch('/api/vault').then((r) => r.json()).then(setV).catch(() => setV({ configured: false })); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  return { vault: v, reloadVault: load };
}

/** A clock that ticks, so time-based states ("bought today", "next buy") move on their own. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/* ---------- shell ---------- */

function Sidebar({ view, go, hired, vault, onOpenHired }: { view: View; go: (v: View) => void; hired: HiredAgent[]; vault: VaultInfo | null; onOpenHired: (id: string) => void }) {
  const { t, lang, setLang } = useT();
  const item = (label: string, v: View, icon: IconName, more?: 'chevron' | 'down') => (
    <button className={`nav-item${view === v ? ' active' : ''}`} onClick={() => go(v)} aria-current={view === v ? 'page' : undefined} data-tip={label}>
      <span className="nav-icon"><Icon name={icon} size={18} /></span>
      <span className="nav-text">{label}</span>
      {more && <span className={`nav-more ${more}`} aria-hidden><Icon name="chevron" size={16} /></span>}
    </button>
  );
  return (
    <aside className="sidebar">
      <div className="brand"><span className="orb sm" aria-hidden /><span className="nav-text">moa</span></div>
      {item(t.navTrade, 'trade', 'chart', 'chevron')}
      {item(t.navAgents, 'agents', 'market')}
      {item(t.navMine, 'mine', 'bot', hired.length ? 'down' : 'chevron')}
      {hired.length > 0 && (
        <div className="nav-sub">
          {hired.slice(0, 4).map((h) => <button key={h.id} className="nav-subitem" onClick={() => onOpenHired(h.id)}>{hiredName(t, h)}</button>)}
          <button className="nav-all" onClick={() => go('mine')}>{t.navAll} →</button>
        </div>
      )}
      <div className="sidebar-foot">
        <div className="nav-item static" data-tip={vault?.configured ? t.vaultOn(short(vault.vault), Number(vault.usdtBalance).toFixed(2), vault.remainingTodayUsdt ?? '0') : t.vaultNone}>
          <span className="nav-icon"><Icon name="shield" size={18} /></span>
          <span className="nav-text">{vault?.configured ? t.vaultOn(short(vault.vault), Number(vault.usdtBalance).toFixed(2), vault.remainingTodayUsdt ?? '0') : t.vaultNone}</span>
        </div>
        <button className="nav-item" onClick={() => setLang(lang === 'en' ? 'ko' : 'en')} data-tip={t.langLabel}>
          <span className="nav-icon"><Icon name="globe" size={18} /></span>
          <span className="nav-text">{t.langLabel}</span>
        </button>
      </div>
    </aside>
  );
}

function TabBar({ view, go, count, asks, onMoa }: { view: View; go: (v: View) => void; count: number; asks: number; onMoa: () => void }) {
  const { t } = useT();
  const tab = (label: string, v: View, icon: IconName, badge?: number) => (
    <button className={`tab${view === v ? ' on' : ''}`} onClick={() => go(v)} aria-current={view === v ? 'page' : undefined}>
      <span className="tab-icon"><Icon name={icon} /></span>{label}{badge ? <span className="nav-badge">{badge}</span> : null}
    </button>
  );
  return (
    <nav className="tabbar" aria-label="Main">
      {tab(t.navTrade, 'trade', 'chart')}
      {tab(t.navAgents, 'agents', 'market')}
      {tab(t.navMine, 'mine', 'bot', count)}
      <button className="tab" onClick={onMoa} aria-label={t.openMoa}>
        <span className="tab-icon"><span className="orb sm" /></span>{t.navMoa}{asks ? <span className="nav-badge ask">{asks}</span> : null}
      </button>
    </nav>
  );
}

function Topbar({ title, quotes, onMenu }: { title: string; quotes: Quote[]; onMenu: () => void }) {
  const hsk = quotes.find((q) => q.asset === 'HSK');
  return (
    <header className="topbar">
      <div className="topbar-title">
        <button className="menu-btn desktop-only" onClick={onMenu} aria-label="Menu"><Icon name="menuFold" size={18} /></button>
        <span className="brand mobile-only"><span className="orb sm" aria-hidden /> moa</span>
        <span className="desktop-only">{title}</span>
      </div>
      <div className="topbar-right">
        {hsk?.pool !== undefined && <span className="top-meta">HSK <RollNum text={fmtPrice(hsk.pool)} /></span>}
      </div>
    </header>
  );
}

function Shell() {
  const { t } = useT();
  const toast = useToast();
  const [view, setView] = useState<View>('trade');
  const quotes = useQuotes();
  const { vault, reloadVault } = useVault();
  const { hired, add, update, remove } = useHired();
  const { execs, record } = useExecutions();
  const now = useNow(30_000);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [extra, setExtra] = useState<Record<string, Agent>>({});
  const [tradeCtx, setTradeCtx] = useState<MoaContext>({ label: '' });
  const [inject, setInject] = useState<MoaInject | null>(null);
  const injectN = useRef(0);
  const [show, setShow] = useState<ShowAgent | null>(null);
  const showN = useRef(0);
  const [sheet, setSheet] = useState<HireTarget | null>(null);
  const [moaOpen, setMoaOpen] = useState(false);
  const [navMini, setNavMini] = useState(false);
  const [sending, setSending] = useState<Set<string>>(new Set());
  const sendingRef = useRef(sending); sendingRef.current = sending;
  const hiredRef = useRef(hired); hiredRef.current = hired;
  const vaultRef = useRef(vault); vaultRef.current = vault;

  // Leaving the trade screen forgets its market, so coming back never reports the one from the visit before.
  const go = (v: View) => { if (v !== 'trade') setTradeCtx({ label: '' }); setView(v); window.scrollTo(0, 0); };
  const tell = (x: MoaAsk) => setInject({ ...x, n: ++injectN.current });
  const attention = () => { if (window.matchMedia(NARROW).matches) setMoaOpen(true); };

  // Agent scores for the market, Moa's picks and the runner. Refreshed every 10 minutes so live signals move.
  useEffect(() => {
    let alive = true;
    const load = () => loadAgents().then((a) => { if (alive) { setAgents(a); setAgentsFailed(false); } }, () => { if (alive) setAgentsFailed(true); });
    load();
    const x = setInterval(load, 10 * 60_000);
    return () => { alive = false; clearInterval(x); };
  }, []);

  // Hired agents that are not in the market listing (e.g. hired from the tiles of a spot market) load on their own.
  const missing = hired.flatMap((h) => (h.source.type === 'market' && !agents?.some((a) => a.id === (h.source as { agentId: string }).agentId) ? [h.source.agentId] : []));
  const missingKey = [...new Set(missing)].sort().join(',');
  useEffect(() => {
    if (!missingKey) return;
    let alive = true;
    const load = () => Promise.all(missingKey.split(',').map((id) => agentById(id).catch(() => null))).then((xs) => {
      if (alive) setExtra((cur) => { const next = { ...cur }; for (const a of xs) if (a) next[a.id] = a; return next; });
    });
    void load();
    const x = setInterval(load, 10 * 60_000);
    return () => { alive = false; clearInterval(x); };
  }, [missingKey]);

  const agentFor = (id: string) => agents?.find((a) => a.id === id) ?? extra[id];
  const signalOf = (h: HiredAgent): Signal | undefined => {
    if (h.source.type === 'custom') return { kind: 'custom', price: quotes.find((q) => q.asset === h.asset)?.pool };
    const a = agentFor(h.source.agentId);
    if (!a) return undefined;
    return a.kind === 'position' ? { kind: 'position', live: a.live } : { kind: 'collect', mult: a.mult };
  };
  const maxTradeUsd = vault?.configured && vault.maxTradeUsdt ? Number(vault.maxTradeUsdt) : undefined;

  // The runner: while the app is open, each hired agent's rule decides its next order. Orders only wait for an answer.
  useEffect(() => {
    const at = Date.now();
    for (const h of hired) {
      const s = signalOf(h);
      if (!s) continue;
      const d = decide(h, s, at, { maxTradeUsd });
      if (d.type === 'order') {
        const order = { ...d.order, id: newId(), at };
        update(h.id, (x) => (x.pending || x.paused ? x : { ...x, pending: order, declined: undefined, log: [...x.log, { at, k: 'asked', order }] }));
      } else if (d.type === 'skip') {
        update(h.id, (x) => (x.lastRunAt !== h.lastRunAt ? x : { ...x, lastRunAt: at, log: [...x.log, { at, k: 'skipped', why: d.why }] }));
      } else if (d.type === 'cancel') {
        update(h.id, (x) => (x.pending && !sendingRef.current.has(x.pending.id) ? { ...x, pending: undefined, log: [...x.log, { at, k: 'expired', orderId: x.pending.id }] } : x));
      } else if (d.clearDeclined) {
        update(h.id, (x) => ({ ...x, declined: undefined }));
      }
    }
  }, [hired, agents, extra, quotes, now, maxTradeUsd]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The user said yes: send this one order to the vault and record exactly what came back. */
  const approve = async (id: string, orderId: string) => {
    const h = hiredRef.current.find((x) => x.id === id);
    const o = h?.pending;
    if (!h || !o || o.id !== orderId || sendingRef.current.has(orderId)) return;
    setSending((cur) => new Set(cur).add(orderId));
    const amount = o.side === 'buy' ? o.usd ?? 0 : o.qty ?? 0;
    const enName = h.source.type === 'market' ? agentName(STRINGS.en, h.source) : STRINGS.en.customName(h.asset);
    // Demo (the server reports no vault): the answer is recorded, nothing is sent.
    const demo = vaultRef.current?.configured === false;
    const r = demo ? { ok: false as const, reason: 'No vault is connected (demo).' } : await sendAgentTrade({ asset: h.asset, side: o.side, amount, note: chainNote(enName, o.why) });
    const at = Date.now();
    const position = h.source.type === 'market' && h.source.kind === 'position';
    const key = 'key' in o.why ? o.why.key : undefined;
    update(id, (x) => {
      const base = { ...x, pending: x.pending?.id === orderId ? undefined : x.pending, fired: key && !x.fired.includes(key) ? [...x.fired, key] : x.fired };
      if (r.ok) {
        const fill = { at, side: o.side, usd: Number(o.side === 'buy' ? r.amountIn : r.amountOut), qty: Number(o.side === 'buy' ? r.amountOut : r.amountIn), txHash: r.txHash, explorerUrl: r.explorerUrl };
        return { ...base, fills: [...x.fills, fill], lastRunAt: o.side === 'buy' ? at : x.lastRunAt, log: [...x.log, { at, k: 'filled', orderId, fill }] };
      }
      return { ...base, declined: position ? o.side : x.declined, lastRunAt: position || o.side === 'sell' ? x.lastRunAt : at, log: [...x.log, { at, k: 'failed', orderId, reason: r.reason, demo }] };
    });
    setSending((cur) => { const next = new Set(cur); next.delete(orderId); return next; });
    reloadVault();
  };

  const decline = (id: string, orderId: string) => update(id, (x) => {
    const o = x.pending;
    if (!o || o.id !== orderId || sendingRef.current.has(orderId)) return x;
    const at = Date.now();
    const position = x.source.type === 'market' && x.source.kind === 'position';
    const key = 'key' in o.why ? o.why.key : undefined;
    return {
      ...x, pending: undefined, declined: position ? o.side : x.declined, lastRunAt: position || o.side === 'sell' ? x.lastRunAt : at,
      fired: key ? [...x.fired, key] : x.fired, log: [...x.log, { at, k: 'declined', orderId }],
    };
  });

  const pause = (id: string) => update(id, (x) => {
    if (x.paused) return x;
    const at = Date.now();
    const drop = x.pending && !sendingRef.current.has(x.pending.id) ? x.pending : undefined;
    return { ...x, paused: true, pending: drop ? undefined : x.pending, log: [...x.log, ...(drop ? [{ at, k: 'expired' as const, orderId: drop.id }] : []), { at, k: 'paused' }] };
  });
  const resume = (id: string) => update(id, (x) => (x.paused ? { ...x, paused: false, declined: undefined, log: [...x.log, { at: Date.now(), k: 'resumed' }] } : x));

  /** The hire sheet's button: the only place a hired agent is created or its amounts change. */
  const confirmSheet = (v: Amounts) => {
    if (!sheet) return;
    const at = Date.now();
    if (sheet.kind === 'edit') {
      const from = { perBuyUsd: sheet.hired.perBuyUsd, budgetUsd: sheet.hired.budgetUsd };
      update(sheet.hired.id, (x) => ({ ...x, ...v, log: [...x.log, { at, k: 'changed', from, to: v }] }));
      tell({ kind: 'hired', hiredId: sheet.hired.id, changed: { from, to: v } });
    } else {
      let h: HiredAgent;
      if (sheet.kind === 'agent') {
        const a = sheet.agent;
        setExtra((cur) => ({ ...cur, [a.id]: a }));
        h = { id: newId(), createdAt: at, source: { type: 'market', agentId: a.id, kind: a.kind, rule: a.rule, base: a.base }, asset: a.base as Asset, ...v, mode: 'ask', paused: false, fired: [], fills: [], log: [{ at, k: 'hired', to: v }] };
      } else {
        const first = sheet.plan.steps.find((s) => 'asset' in s) as { asset?: Asset } | undefined;
        h = { id: newId(), createdAt: at, source: { type: 'custom', goal: sheet.goal, plan: sheet.plan }, asset: first?.asset ?? 'HSK', ...v, mode: 'ask', paused: false, fired: [], fills: [], log: [{ at, k: 'hired', to: v }] };
      }
      add(h);
      toast(t.hiredSay(hiredName(t, h)));
      tell({ kind: 'hired', hiredId: h.id });
    }
    setSheet(null);
  };

  const ctx: MoaContext = view === 'trade' ? tradeCtx : view === 'agents' ? { label: t.ctxMarket } : { label: t.ctxMine };
  const asks = hired.filter((h) => h.pending).length;
  const title = { trade: t.navTrade, agents: t.agTitle, mine: t.mineTitle }[view];
  const askMoaAbout = (a: Agent) => tell({ kind: 'agent', agent: a });
  // "See the backtest" from Moa's card or the agent market: the trade screen opens that agent on its own chart.
  const openBacktest = (a: Agent) => { setShow({ agent: a, n: ++showN.current }); go('trade'); if (window.matchMedia(NARROW).matches) setMoaOpen(false); };

  return (
    <div className={`app${moaOpen ? ' moa-open' : ''}${navMini ? ' nav-mini' : ''}`}>
      <Sidebar view={view} go={go} hired={hired} vault={vault} onOpenHired={(id) => tell({ kind: 'status', hiredId: id })} />
      <main className="main">
        <Topbar title={title} quotes={quotes} onMenu={() => setNavMini((v) => !v)} />
        <MyAgentsBar hired={hired} quotes={quotes} now={now} sending={sending}
          onOpen={(id) => tell({ kind: 'status', hiredId: id })} onPause={pause} onResume={resume} />
        {view === 'trade' && <Trade quotes={quotes} show={show} onContext={setTradeCtx} onAsk={askMoaAbout} onHire={(a) => setSheet({ kind: 'agent', agent: a })} />}
        {view === 'agents' && <Agents agents={agents} failed={agentsFailed && !agents} onHire={(a) => setSheet({ kind: 'agent', agent: a })} onOpen={openBacktest} onRecommend={() => tell({ kind: 'recommend' })} />}
        {view === 'mine' && (
          <MyAgents hired={hired} quotes={quotes} vault={vault} execs={execs} now={now}
            onEdit={(id) => { const h = hired.find((x) => x.id === id); if (h) setSheet({ kind: 'edit', hired: h }); }}
            onPause={pause} onResume={resume} onRemove={remove} onOpen={(id) => tell({ kind: 'status', hiredId: id })}
            onRecommend={() => tell({ kind: 'recommend' })} />
        )}
      </main>
      <div className="moa-col">
        <MoaFeed quotes={quotes} vault={vault} inject={inject} context={ctx} agents={agents} agentsFailed={agentsFailed}
          hired={hired} sending={sending} now={now}
          onHire={setSheet} onEdit={(id) => { const h = hiredRef.current.find((x) => x.id === id); if (h) setSheet({ kind: 'edit', hired: h }); }}
          onPause={pause} onResume={resume} onApprove={(id, o) => void approve(id, o)} onDecline={decline}
          onExecuted={(x) => { record(x); reloadVault(); }} onGoto={(v) => { go(v); if (window.matchMedia(NARROW).matches) setMoaOpen(false); }} onShow={openBacktest}
          onAttention={attention} onClose={() => setMoaOpen(false)} />
      </div>
      {moaOpen && <div className="moa-scrim" onClick={() => setMoaOpen(false)} aria-hidden />}
      {!moaOpen && (
        <button className="moa-fab" onClick={() => setMoaOpen(true)} aria-label={t.openMoa}>
          <span className="orb sm breathe" aria-hidden /> Moa{asks ? <span className="nav-badge ask">{asks}</span> : null}
        </button>
      )}
      <TabBar view={view} go={go} count={hired.length} asks={asks} onMoa={() => setMoaOpen((v) => !v)} />
      {sheet && <HireSheet target={sheet} vault={vault} onClose={() => setSheet(null)} onConfirm={confirmSheet} />}
    </div>
  );
}

export default function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => { setLangState(l); saveLang(l); };
  const t = STRINGS[lang];
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  return (
    <LangContext.Provider value={{ lang, t, setLang }}>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </LangContext.Provider>
  );
}
