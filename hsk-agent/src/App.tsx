// The shell. Three screens (trade, agent market, my agents), the "My agents" bar on top of all of them,
// and one Moa conversation docked on the right of all of them. On small screens Moa slides up as a sheet.
// The agent market shows, Moa picks and explains, hired agents work:
//  - the hire sheet is the only place amounts change
//  - the runner below decides each hired agent's next order from its rule, and every order waits for the
//    user's OK in Moa's conversation before it goes to the vault (which enforces its limits again)
//  - pausing works from the bar without Moa or the AI
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadQuotes, type Quote } from './market.ts';
import { useExecutions, useHired } from './store.ts';
import { LangContext, STRINGS, initialLang, saveLang, useT, type Lang } from './i18n.ts';
import { Icon, type IconName } from './Icons.tsx';
import Trade, { type ShowAgent } from './Trade.tsx';
import { VaultMini } from './VaultCard.tsx';
import AccountButton from './Account.tsx';
import { authHeaders, logOut, useSession } from './account.ts';
import Builder, { type BuildDraft } from './Builder.tsx';
import Agents from './Agents.tsx';
import MyAgents from './MyAgents.tsx';
import MyAgentsBar from './MyAgentsBar.tsx';
import MineDock from './MineDock.tsx';
import type { LpPlan } from './lp.ts';
import MoaFeed, { type MoaAsk, type MoaContext, type MoaInject } from './MoaFeed.tsx';
import HireSheet, { type HireTarget } from './HireSheet.tsx';
import { agentById, loadAgents, type Agent } from './agents.ts';
import type { Asset } from './intent.ts';
import { chainNote, decide, newId, type HireChoice, type HiredAgent, type Signal } from './runner.ts';
import { hiredName } from './hiredText.ts';
import { agentName } from './AgentCard.tsx';
import { autoList, autoPut, autoRemove, sendAgentTrade } from './moaClient.ts';
import type { VaultInfo } from './parts.tsx';
import { ToastProvider, useToast } from './ui.tsx';

type View = 'trade' | 'agents' | 'build' | 'mine';
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

/**
 * The logged-in wallet's vault. A wallet that logs in for the first time has none yet: the server makes it (and pays
 * for it) once, here, without the user signing anything. Logged out, or on a server without the vault service, the
 * answer is "not configured" and the app stays a demo.
 */
function useVault() {
  const s = useSession();
  const token = s?.token;
  const [v, setV] = useState<VaultInfo | null>(null);
  const [make, setMake] = useState<{ for: string; busy: boolean; error?: string } | null>(null);
  const load = useCallback(() => {
    fetch('/api/vault', { headers: authHeaders() }).then((r) => r.json()).then((j: VaultInfo) => {
      // The server no longer knows this session (it expired, or the server restarted with a new secret).
      if (token && j.signedIn === false) logOut();
      setV(j);
      // One failed check (the server restarting, the network) keeps what was known instead of flipping to "demo".
    }).catch(() => setV((had) => had ?? { configured: false }));
  }, [token]);
  useEffect(() => { setV(null); load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  const create = useCallback((address: string) => {
    setMake({ for: address, busy: true });
    fetch('/api/vault/create', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: '{}' })
      .then((r) => r.json()).then((j: { ok?: boolean; reason?: string; error?: string }) => { setMake({ for: address, busy: false, error: j.ok ? undefined : j.reason ?? j.error ?? 'unknown error' }); load(); })
      .catch((e: unknown) => setMake({ for: address, busy: false, error: e instanceof Error ? e.message : String(e) }));
  }, [load]);
  const address = s?.address;
  useEffect(() => {
    if (address && v?.signedIn && v.service && !v.configured && make?.for !== address) create(address);
  }, [address, v, make, create]);
  const mine = make && make.for === address ? make : null;
  const vault: VaultInfo | null = v && !v.configured && mine ? { ...v, making: mine.busy, makeError: mine.error } : v;
  return { vault, reloadVault: load, retryVault: () => { if (address) create(address); } };
}

/** A clock that ticks, so time-based states ("bought today", "next buy") move on their own. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}


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
      {item(t.navBuild, 'build', 'plus')}
      {item(t.navMine, 'mine', 'bot', hired.length ? 'down' : 'chevron')}
      {hired.length > 0 && (
        <div className="nav-sub">
          {hired.slice(0, 4).map((h) => <button key={h.id} className="nav-subitem" onClick={() => onOpenHired(h.id)}>{hiredName(t, h)}</button>)}
          <button className="nav-all" onClick={() => go('mine')}>{t.navAll} →</button>
        </div>
      )}
      <div className="sidebar-foot">
        <VaultMini vault={vault} />
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

function Topbar({ title, vault, onMenu, onReload, onRetryVault }: { title: string; vault: VaultInfo | null; onMenu: () => void; onReload: () => void; onRetryVault: () => void }) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <button className="menu-btn desktop-only" onClick={onMenu} aria-label="Menu"><Icon name="menuFold" size={18} /></button>
        <span className="brand mobile-only"><span className="orb sm" aria-hidden /> moa</span>
        <span className="desktop-only">{title}</span>
      </div>
      <div className="topbar-right">
        <AccountButton vault={vault} onReload={onReload} onRetryVault={onRetryVault} />
      </div>
    </header>
  );
}

function Shell() {
  const { t } = useT();
  const toast = useToast();
  const [view, setView] = useState<View>('trade');
  const quotes = useQuotes();
  const { vault, reloadVault, retryVault } = useVault();
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
  const [build, setBuild] = useState<BuildDraft | null>(null);
  const buildN = useRef(0);
  /** Open the builder: empty, on the coin on screen, with a sentence to read, or on a saved agent. */
  const openBuilder = (x: Omit<BuildDraft, 'n'> = {}) => { setBuild({ ...x, n: ++buildN.current }); go('build'); if (window.matchMedia(NARROW).matches) setMoaOpen(false); };
  const showN = useRef(0);
  const [sheet, setSheet] = useState<HireTarget | null>(null);
  // The liquidity studio's plan: the HSKSwap screen edits it, Moa fills it from the conversation. Null when closed.
  const [lp, setLp] = useState<LpPlan | null>(null);
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
  /** Opening the liquidity studio also starts Moa's walk-through; closing it ends the plan. */
  const openLp = (p: LpPlan | null) => { setLp((had) => { if (p && !had) setTimeout(() => tell({ kind: 'lp' }), 0); return p; }); };

  // Agent scores for the market, Moa's picks and the runner. Refreshed every 10 minutes so live signals move.
  const [agentsTry, setAgentsTry] = useState(0);
  useEffect(() => {
    let alive = true;
    setAgentsFailed(false);
    const load = () => loadAgents().then((a) => { if (alive) { setAgents(a); setAgentsFailed(false); } }, () => { if (alive) setAgentsFailed(true); });
    load();
    const x = setInterval(load, 10 * 60_000);
    return () => { alive = false; clearInterval(x); };
  }, [agentsTry]);

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
      if (h.mode === 'auto') continue;   // the server runs these, app open or not
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
    // Demo (no vault: not logged in, or this server has no vault service): the answer is recorded, nothing is sent.
    const demo = !vaultRef.current?.configured;
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

  const pauseLocal = (id: string) => update(id, (x) => {
    if (x.paused) return x;
    const at = Date.now();
    const drop = x.pending && !sendingRef.current.has(x.pending.id) ? x.pending : undefined;
    return { ...x, paused: true, pending: drop ? undefined : x.pending, log: [...x.log, ...(drop ? [{ at, k: 'expired' as const, orderId: drop.id }] : []), { at, k: 'paused' }] };
  });
  const resumeLocal = (id: string) => update(id, (x) => (x.paused ? { ...x, paused: false, declined: undefined, log: [...x.log, { at: Date.now(), k: 'resumed' }] } : x));

  /* ----- agents that work on their own: the server holds them, this browser shows them ----- */
  const session = useSession();
  /** Tell the server about an auto agent (new, new amounts, paused or resumed). If it refuses, the agent goes back to asking. */
  const pushAuto = (h: HiredAgent) => {
    void autoPut(h).then((r) => {
      if (r.ok) return;
      update(h.id, (x) => ({ ...x, mode: 'ask' }));
      toast(r.why === 'noVault' || r.why === 'login' ? t.hsAutoLogin : t.autoFailed);
    });
  };
  const autoOf = (id: string) => { const h = hiredRef.current.find((x) => x.id === id); return h?.mode === 'auto' ? h : undefined; };
  const pause = (id: string) => { const a = autoOf(id); pauseLocal(id); if (a) pushAuto({ ...a, paused: true }); };
  const resume = (id: string) => { const a = autoOf(id); resumeLocal(id); if (a) pushAuto({ ...a, paused: false }); };
  const removeHired = (id: string) => { if (autoOf(id)) void autoRemove(id); remove(id); };
  const token = session?.token;
  useEffect(() => {
    if (!token) return;
    let alive = true;
    const pull = () => void autoList().then((list) => {
      if (!alive || !list) return;
      for (const s of list) {
        const local = hiredRef.current.find((x) => x.id === s.id);
        if (!local) { add(s); continue; }
        if (local.mode !== 'auto') continue;
        if (s.fills.length === local.fills.length && s.log.length === local.log.length && s.paused === local.paused) continue;
        update(s.id, () => s);
        if (s.fills.length > local.fills.length) { toast(t.autoFilled(hiredName(t, s))); tell({ kind: 'status', hiredId: s.id }); }
      }
      // An auto agent the server does not have yet (hired a moment ago, or the server lost its file): send it.
      for (const l of hiredRef.current) if (l.mode === 'auto' && !list.some((s) => s.id === l.id)) void autoPut(l);
    });
    pull();
    const x = setInterval(pull, 30_000);
    return () => { alive = false; clearInterval(x); };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The hire sheet's button: the only place a hired agent is created or its amounts change. */
  const confirmSheet = (choice: HireChoice) => {
    if (!sheet) return;
    const at = Date.now();
    const v = { perBuyUsd: choice.perBuyUsd, budgetUsd: choice.budgetUsd };
    const mode = choice.mode;
    if (sheet.kind === 'edit') {
      const from = { perBuyUsd: sheet.hired.perBuyUsd, budgetUsd: sheet.hired.budgetUsd };
      const was = sheet.hired.mode;
      update(sheet.hired.id, (x) => ({ ...x, ...v, mode, pending: mode === 'auto' ? undefined : x.pending, log: [...x.log, { at, k: 'changed', from, to: v }] }));
      if (mode === 'auto') pushAuto({ ...sheet.hired, ...v, mode, pending: undefined });
      // Back to asking: the server lets go of it, and what it did there comes home with it.
      else if (was === 'auto') void autoRemove(sheet.hired.id).then((last) => { if (last) update(last.id, (x) => ({ ...last, ...v, mode: 'ask', paused: x.paused })); });
      tell({ kind: 'hired', hiredId: sheet.hired.id, changed: { from, to: v } });
    } else {
      let h: HiredAgent;
      if (sheet.kind === 'agent') {
        const a = sheet.agent;
        setExtra((cur) => ({ ...cur, [a.id]: a }));
        h = { id: newId(), createdAt: at, source: { type: 'market', agentId: a.id, kind: a.kind, rule: a.rule, base: a.base }, asset: a.base as Asset, ...v, mode, spec: a.made, paused: false, fired: [], fills: [], log: [{ at, k: 'hired', to: v }] };
      } else {
        const first = sheet.plan.steps.find((s) => 'asset' in s) as { asset?: Asset } | undefined;
        h = { id: newId(), createdAt: at, source: { type: 'custom', goal: sheet.goal, plan: sheet.plan }, asset: first?.asset ?? 'HSK', ...v, mode, paused: false, fired: [], fills: [], log: [{ at, k: 'hired', to: v }] };
      }
      add(h);
      if (mode === 'auto') pushAuto(h);
      toast(t.hiredSay(hiredName(t, h)));
      tell({ kind: 'hired', hiredId: h.id });
    }
    setSheet(null);
  };

  const ctx: MoaContext = view === 'trade' ? tradeCtx : view === 'agents' ? { label: t.ctxMarket } : view === 'build' ? { label: t.ctxBuild } : { label: t.ctxMine };
  const asks = hired.filter((h) => h.pending).length;
  const title = { trade: t.navTrade, agents: t.agTitle, build: t.navBuild, mine: t.mineTitle }[view];
  const askMoaAbout = (a: Agent) => tell({ kind: 'agent', agent: a });
  // "See the backtest" from Moa's card or the agent market: the trade screen opens that agent on its own chart.
  const openBacktest = (a: Agent) => { setShow({ agent: a, n: ++showN.current }); go('trade'); if (window.matchMedia(NARROW).matches) setMoaOpen(false); };

  return (
    <div className={`app${moaOpen ? ' moa-open' : ''}${navMini ? ' nav-mini' : ''}`}>
      <Sidebar view={view} go={go} hired={hired} vault={vault} onOpenHired={(id) => tell({ kind: 'status', hiredId: id })} />
      <main className="main">
        <Topbar title={title} vault={vault} onMenu={() => setNavMini((v) => !v)} onReload={reloadVault} onRetryVault={retryVault} />
        {/* On the trade screen the agents have their own tab under the chart, with the numbers; elsewhere, the bar. */}
        {view !== 'trade' && <MyAgentsBar hired={hired} quotes={quotes} now={now} sending={sending}
          onOpen={(id) => tell({ kind: 'status', hiredId: id })} onPause={pause} onResume={resume} />}
        {view === 'trade' && <Trade quotes={quotes} show={show} lp={{ plan: lp, setPlan: openLp, vault }}
          mine={{ count: hired.length, asks, node: <MineDock hired={hired} quotes={quotes} vault={vault} now={now} sending={sending} onOpen={(id) => tell({ kind: 'status', hiredId: id })} onEdit={(id) => { const h = hired.find((x) => x.id === id); if (h) setSheet({ kind: 'edit', hired: h }); }} onPause={pause} onResume={resume} /> }} onContext={setTradeCtx} onAsk={askMoaAbout} onBuild={(coin) => openBuilder({ coin })} onHire={(a) => setSheet({ kind: 'agent', agent: a })} />}
        {view === 'agents' && <Agents agents={agents} failed={agentsFailed && !agents} onRetry={() => setAgentsTry((n) => n + 1)} onHire={(a) => setSheet({ kind: 'agent', agent: a })} onOpen={openBacktest} onRecommend={() => tell({ kind: 'recommend' })} />}
        {view === 'build' && <Builder draft={build} onOpen={openBacktest} />}
        {view === 'mine' && (
          <MyAgents hired={hired} quotes={quotes} vault={vault} execs={execs} now={now}
            onEdit={(id) => { const h = hired.find((x) => x.id === id); if (h) setSheet({ kind: 'edit', hired: h }); }}
            onPause={pause} onResume={resume} onRemove={removeHired} onOpen={(id) => tell({ kind: 'status', hiredId: id })}
            onRecommend={() => tell({ kind: 'recommend' })} />
        )}
      </main>
      <div className="moa-col">
        <MoaFeed lp={lp} onLp={setLp} quotes={quotes} vault={vault} inject={inject} context={ctx} agents={agents} agentsFailed={agentsFailed}
          hired={hired} sending={sending} now={now}
          onHire={setSheet} onEdit={(id) => { const h = hiredRef.current.find((x) => x.id === id); if (h) setSheet({ kind: 'edit', hired: h }); }}
          onPause={pause} onResume={resume} onApprove={(id, o) => void approve(id, o)} onDecline={decline}
          onExecuted={(x) => { record(x); reloadVault(); }} onGoto={(v) => { go(v); if (window.matchMedia(NARROW).matches) setMoaOpen(false); }} onShow={openBacktest} onBuild={(text) => openBuilder({ text, coin: tradeCtx.asset })}
          onAttention={attention} onClose={() => setMoaOpen(false)} />
      </div>
      {moaOpen && <div className="moa-scrim" onClick={() => setMoaOpen(false)} aria-hidden />}
      {!moaOpen && (
        <button className="moa-fab" onClick={() => setMoaOpen(true)} aria-label={t.openMoa}>
          <span className="orb sm breathe" aria-hidden /> Moa{asks ? <span className="nav-badge ask">{asks}</span> : null}
        </button>
      )}
      <TabBar view={view} go={go} count={hired.length} asks={asks} onMoa={() => setMoaOpen((v) => !v)} />
      {sheet && <HireSheet target={sheet} vault={vault} onClose={() => setSheet(null)} onConfirm={confirmSheet} onReloadVault={reloadVault} />}
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
