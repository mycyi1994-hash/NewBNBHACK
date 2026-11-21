import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { botName, describe, parseIntent, scheduleOf, type Plan, type Step } from './intent.ts';
import { fmtPrice, loadQuotes, type Quote } from './market.ts';
import { reply } from './moa.ts';
import { useBots, useExecutions, type Bot, type Execution } from './store.ts';
import { LangContext, STRINGS, initialLang, saveLang, useT, type Lang } from './i18n.ts';
import Trade from './Trade.tsx';
import { SpreadTable, VaultPanel, type VaultInfo } from './parts.tsx';

type View = { name: 'trade' } | { name: 'chat'; prefill?: string; auto?: boolean } | { name: 'bots' } | { name: 'bot'; id: string };
type StepKey = 'thinking' | 'market' | 'plan' | 'execute' | 'writing';
interface Exec { ok: boolean; reason?: string; txHash?: string; explorerUrl?: string; amountIn?: string; amountOut?: string; tokenIn?: string; tokenOut?: string; request: { asset: string; side: string; amount: number } }
interface Msg { role: 'moa' | 'you'; text: string; at: number; execs?: Exec[]; offline?: boolean }
interface ServerStep { kind: Step['kind']; asset?: 'HSK' | 'ETH' | 'BTC'; perBuyUsd?: number; every?: 'hour' | 'day' | 'week'; durationDays?: number; targetQty?: number; deadline?: string; maxPrice?: number; budgetUsd?: number; dropPct?: number; risePct?: number; sellFraction?: number; what?: 'idle USDT' | 'accumulated coins' }

/** The server's plan has optional fields; fill in the shape the plan cards expect. */
function toStep(s: ServerStep): Step {
  const asset = s.asset ?? 'HSK';
  switch (s.kind) {
    case 'accumulate': return { kind: 'accumulate', asset, perBuyUsd: s.perBuyUsd, every: s.every, durationDays: s.durationDays, targetQty: s.targetQty, deadline: s.deadline, maxPrice: s.maxPrice, budgetUsd: s.budgetUsd };
    case 'stopLoss': return { kind: 'stopLoss', asset, dropPct: s.dropPct ?? 0, sellFraction: s.sellFraction ?? 1 };
    case 'takeProfit': return { kind: 'takeProfit', asset, risePct: s.risePct ?? 0, sellFraction: s.sellFraction ?? 1 };
    default: return { kind: 'earn', what: s.what ?? 'idle USDT' };
  }
}

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
  const load = useCallback(() => { fetch('/api/vault').then((r) => r.json()).then(setV).catch(() => setV({ configured: false })); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  return { vault: v, reloadVault: load };
}

const time = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/* ---------- shell ---------- */

function Logo() {
  return (
    <span className="logo" aria-label="Moa">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><rect width="20" height="20" rx="4" fill="currentColor" /><path d="M5 14V6l5 5 5-5v8" fill="none" stroke="var(--bg)" strokeWidth="2" strokeLinejoin="round" /></svg>
      MOA
    </span>
  );
}

function TopNav({ view, go, botCount, quotes, vault }: { view: View; go: (v: View) => void; botCount: number; quotes: Quote[]; vault: VaultInfo | null }) {
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
        {link(t.navAsk, { name: 'chat' }, view.name === 'chat')}
        {link(t.navBots, { name: 'bots' }, view.name === 'bots' || view.name === 'bot', botCount)}
      </nav>
      <div className="nav-right">
        {hsk?.pool !== undefined && <span className="nav-quote"><span>HSK</span>{fmtPrice(hsk.pool)}</span>}
        <span className="status-dot on desktop-only">HSK Chain</span>
        {vault?.configured && <span className="nav-quote desktop-only"><span>{t.vaultTitle}</span>{Number(vault.usdtBalance).toFixed(2)} USDT</span>}
        <button className="btn-ghost sm" onClick={() => setLang(lang === 'en' ? 'ko' : 'en')} aria-label="Switch language">{t.langLabel}</button>
      </div>
    </header>
  );
}

function TabBar({ view, go, botCount }: { view: View; go: (v: View) => void; botCount: number }) {
  const { t } = useT();
  const tab = (label: string, v: View, active: boolean, badge?: number) => (
    <button className={`tab${active ? ' on' : ''}`} onClick={() => go(v)} aria-current={active ? 'page' : undefined}>
      {label}{badge ? <span className="count">{badge}</span> : null}
    </button>
  );
  return (
    <nav className="tabbar" aria-label="Main">
      {tab(t.navTrade, { name: 'trade' }, view.name === 'trade')}
      {tab(t.navAsk, { name: 'chat' }, view.name === 'chat')}
      {tab(t.navBots, { name: 'bots' }, view.name === 'bots' || view.name === 'bot', botCount)}
    </nav>
  );
}

/* ---------- shared Moa pieces ---------- */

/** A fill confirmation, laid out like an exchange's order receipt. */
function Receipt({ x }: { x: Exec }) {
  const { t } = useT();
  const side = x.request.side === 'buy' ? t.buy : t.sell;
  return (
    <div className={`receipt ${x.ok ? 'ok' : 'bad'}`}>
      <span className="receipt-status">{x.ok ? t.executed : t.notExecuted}</span>
      <span className={x.request.side === 'buy' ? 'pos' : 'neg'}>{side} {x.request.asset}</span>
      {x.ok
        ? <span className="receipt-line">{x.amountIn} {x.tokenIn} → {Number(x.amountOut).toPrecision(6)} {x.tokenOut}</span>
        : <span className="receipt-line">${x.request.amount} · {x.reason}</span>}
      {x.ok && <a href={x.explorerUrl} target="_blank" rel="noreferrer">{short(x.txHash)} ↗</a>}
    </div>
  );
}

function Progress({ steps, startedAt }: { steps: StepKey[]; startedAt: number }) {
  const { t } = useT();
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((v) => v + 1), 1000); return () => clearInterval(i); }, []);
  const secs = Math.round((Date.now() - startedAt) / 1000);
  return (
    <div className="log-row moa progress" role="status" aria-live="polite">
      <div className="log-meta"><b>Moa</b><time>{secs}s</time></div>
      <ol className="log-body">
        {steps.map((s, i) => (
          <li key={i} className={i === steps.length - 1 ? 'now' : 'done'}>
            <span className="pmark" aria-hidden>{i === steps.length - 1 ? <span className="spinner" /> : '✓'}</span>
            {t.steps[s]}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- chat ---------- */

function Chat({ prefill, auto, quotes, vault, onCreate, onExecuted }: {
  prefill?: string; auto?: boolean; quotes: Quote[]; vault: VaultInfo | null;
  onCreate: (goal: string, plan: Plan) => void; onExecuted: (x: Execution[]) => void;
}) {
  const { t, lang } = useT();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState(auto ? '' : prefill ?? '');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState<{ steps: StepKey[]; at: number } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const started = msgs.length > 0;

  useEffect(() => {
    // Recent Chromium returns a Promise from scrollIntoView; an effect must not return it.
    void end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, busy]);

  const send = async (text: string) => {
    const tx = text.trim();
    if (!tx || busy) return;
    setDraft('');
    const history = [...msgs, { role: 'you' as const, text: tx, at: Date.now() }];
    setMsgs(history);
    setBusy({ steps: ['thinking'], at: Date.now() });
    const finish = (m: Msg, p: Plan | null, g: string) => {
      if (p && p.steps.length) { setPlan(p); setGoal(g); }
      setBusy(null);
      setMsgs((cur) => [...cur, m]);
    };
    try {
      const r = await fetch('/api/moa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history: history.map((m) => ({ role: m.role === 'you' ? 'user' : 'assistant', content: m.text })) }),
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as { type: string; step?: StepKey; error?: string; result?: { reply: string; plan?: { steps: ServerStep[]; missing: string[] }; executions: Exec[] } };
          if (ev.type === 'step' && ev.step) setBusy((b) => (b && b.steps[b.steps.length - 1] !== ev.step ? { ...b, steps: [...b.steps, ev.step!] } : b));
          else if (ev.type === 'error') throw new Error(ev.error);
          else if (ev.type === 'done' && ev.result) {
            const res = ev.result;
            const p = res.plan ? { steps: res.plan.steps.map(toStep), missing: res.plan.missing } : null;
            if (res.executions?.length) onExecuted(res.executions.map((x) => ({ at: Date.now(), ok: x.ok, asset: x.request.asset, side: x.request.side, amount: x.request.amount, reason: x.reason, txHash: x.txHash, explorerUrl: x.explorerUrl, amountIn: x.amountIn, amountOut: x.amountOut, tokenIn: x.tokenIn, tokenOut: x.tokenOut })));
            finish({ role: 'moa', text: res.reply, at: Date.now(), execs: res.executions?.length ? res.executions : undefined }, p, tx);
            return;
          }
        }
      }
      throw new Error('stream ended without a result');
    } catch {
      // No server (static hosting) or the API failed: fall back to the on-device parser, clearly marked.
      const merged = plan && plan.missing.length && goal ? `${goal}, ${tx}` : tx;
      const p = parseIntent(merged);
      finish({ role: 'moa', text: reply(p, quotes, lang), at: Date.now(), offline: true }, p, merged);
    }
  };

  const sentAuto = useRef(false);
  useEffect(() => {
    if (auto && prefill && !sentAuto.current) { sentAuto.current = true; void send(prefill); }
  });

  const composer = (big: boolean) => (
    <form className={`composer${big ? ' big' : ''}`} onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={big ? t.heroPlaceholder : t.replyPlaceholder} aria-label="Message Moa" autoFocus />
      <button className="btn-primary" type="submit" disabled={!draft.trim() || !!busy}>{t.send} <span className="kbd">↵</span></button>
    </form>
  );

  return (
    <div className="chat-layout">
      <section className="panel chat-main">
        <div className="panel-head"><span>{t.heroTitle}</span>{started && <span className="muted">{t.started} {time(msgs[0].at)}</span>}</div>
        {!started ? (
          <div className="hero">
            <p className="hero-sub">{t.heroSub}</p>
            {composer(true)}
            <table className="grid-table templates">
              <tbody>
                {t.starters.map((s) => (
                  <tr key={s.title} onClick={() => void send(s.prompt)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') void send(s.prompt); }}>
                    <td className="tpl-name">{s.title}</td>
                    <td className="muted">{s.sub}</td>
                    <td className="tpl-prompt">{s.prompt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="chat-scroll">
              {msgs.map((m, i) => (
                <div key={i} className={`log-row ${m.role}`}>
                  <div className="log-meta"><b>{m.role === 'moa' ? 'Moa' : t.you}</b><time>{time(m.at)}</time></div>
                  <div className="log-body">
                    <div className="log-text">{m.text}</div>
                    {m.execs?.map((x, k) => <Receipt key={k} x={x} />)}
                    {m.offline && <div className="offline">{t.offline}</div>}
                  </div>
                </div>
              ))}
              {busy && <Progress steps={busy.steps} startedAt={busy.at} />}
              <div ref={end} />
            </div>
            <div className="chat-bottom">{composer(false)}</div>
          </>
        )}
      </section>
      <aside className="side">
        <section className="panel">
          <div className="panel-head"><span>{t.plan}</span></div>
          {plan ? (
            <div className="pad">
              <PlanSteps steps={plan.steps} />
              {plan.missing.length > 0 && <div className="needs">{t.needs} {plan.missing[0]}</div>}
              <div className="sub-label">{t.guardrails}</div>
              <ul className="guards"><li>{t.guard1}</li><li>{t.guard2}</li><li>{t.guard3}</li></ul>
              <button className="btn-primary wide" disabled={plan.missing.length > 0} onClick={() => onCreate(goal, plan)}>{t.createBot}</button>
            </div>
          ) : <p className="pad muted">{t.noPlan}</p>}
        </section>
        <VaultPanel vault={vault} />
        <SpreadTable quotes={quotes} />
      </aside>
    </div>
  );
}

function PlanSteps({ steps }: { steps: Step[] }) {
  const { t, lang } = useT();
  return (
    <ol className="steps">
      {steps.map((s, i) => {
        const sch = s.kind === 'accumulate' ? scheduleOf(s) : {};
        return (
          <li key={i} className={`step step-${s.kind}`}>
            <span className="step-tag">{t.tags[s.kind]}</span>
            <span>{describe(s, lang)}</span>
            {sch.buys !== undefined && <span className="step-meta">{sch.buys} × · ${sch.totalUsd?.toLocaleString('en-US')}</span>}
          </li>
        );
      })}
    </ol>
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
const botExecs = (bot: Bot, execs: Execution[]) => execs.filter((x) => x.at >= bot.createdAt && botAssets(bot).has(x.asset as 'HSK'));

function BotList({ bots, go, execs }: { bots: Bot[]; go: (v: View) => void; execs: Execution[] }) {
  const { t } = useT();
  return (
    <table className="grid-table bots-table">
      <thead><tr><th>{t.colBot}</th><th>{t.colGoal}</th><th className="r">{t.colSpent}</th><th className="r">{t.colStatus}</th></tr></thead>
      <tbody>
        {bots.map((b) => {
          const spent = botExecs(b, execs).filter((x) => x.ok && x.side === 'buy').reduce((s, x) => s + x.amount, 0);
          const budget = botBudget(b);
          return (
            <tr key={b.id} tabIndex={0} onClick={() => go({ name: 'bot', id: b.id })} onKeyDown={(e) => { if (e.key === 'Enter') go({ name: 'bot', id: b.id }); }}>
              <td className="strong">{b.name}</td>
              <td className="muted ellipsis">{b.goal}</td>
              <td className="r">${spent.toFixed(2)}{budget !== undefined ? <span className="muted"> / ${budget.toFixed(0)}</span> : null}</td>
              <td className="r"><span className="status draft">{t.draft}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Bots({ bots, go, execs }: { bots: Bot[]; go: (v: View) => void; execs: Execution[] }) {
  const { t } = useT();
  return (
    <div className="page">
      <div className="card-head">
        <div>
          <h1 className="hello">{t.bots}</h1>
          <p className="muted">{t.botsSub}</p>
        </div>
        <button className="btn-primary" onClick={() => go({ name: 'chat' })}>{t.newBot}</button>
      </div>
      <section className="card">
        {bots.length ? <BotList bots={bots} go={go} execs={execs} /> : (
          <div className="empty">
            <div className="empty-title">{t.noBots}</div>
            <div className="muted">{t.noBotsSub}</div>
            <button className="btn-ghost" onClick={() => go({ name: 'chat' })}>{t.navAsk}</button>
          </div>
        )}
      </section>
    </div>
  );
}

function BotDetail({ bot, onDelete, execs, vault }: { bot: Bot; onDelete: () => void; execs: Execution[]; vault: VaultInfo | null }) {
  const { t } = useT();
  const [tab, setTab] = useState<'overview' | 'activity'>('overview');
  const mine = botExecs(bot, execs);
  const spent = mine.filter((x) => x.ok && x.side === 'buy').reduce((s, x) => s + x.amount, 0);
  const budget = botBudget(bot);
  return (
    <div className="page narrow">
      <div className="card-head">
        <div className="row-gap">
          <div>
            <h1 className="hello">{bot.name}</h1>
            <p className="muted">{t.created} {new Date(bot.createdAt).toLocaleDateString('en-US')}</p>
          </div>
        </div>
        <div className="row-gap">
          <span className="status draft">{t.draft}</span>
          <button className="btn-ghost" onClick={onDelete}>{t.delete}</button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>{t.overview}</button>
        <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>{t.activity} {mine.length ? `(${mine.length})` : ''}</button>
      </div>
      {tab === 'overview' ? (
        <div className="detail-grid">
          <section className="card">
            <div className="panel-label">{t.goal}</div>
            <p className="goal">“{bot.goal}”</p>
            <div className="panel-label">{t.plan}</div>
            <PlanSteps steps={bot.plan.steps} />
          </section>
          <div className="detail-side">
            <section className="card">
              <div className="panel-label">{t.progress}</div>
              <div className="big-num">${spent.toFixed(2)}</div>
              <div className="muted">{budget !== undefined ? t.spent(spent.toFixed(2), budget.toFixed(0)) : t.spentOpen(spent.toFixed(2))}</div>
              {budget !== undefined && <div className="bar" aria-hidden><span style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} /></div>}
              <div className="panel-label top-gap">{t.nextRun}</div>
              <p className="muted small-text">{t.nextRunOff}</p>
            </section>
            <section className="card">
              <div className="panel-label">{t.limits}</div>
              {vault?.configured ? (
                <dl className="kv">
                  <dt>{t.perTrade}</dt><dd>${vault.maxTradeUsdt}</dd>
                  <dt>{t.perDay}</dt><dd>${vault.maxDailyUsdt}</dd>
                  <dt>{t.leftToday}</dt><dd>${vault.remainingTodayUsdt}</dd>
                  <dt>{t.balance}</dt><dd>{Number(vault.usdtBalance).toFixed(2)}</dd>
                </dl>
              ) : <p className="muted small-text">{t.noVault}</p>}
            </section>
          </div>
        </div>
      ) : mine.length ? (
        <section className="card">
          {mine.map((x, i) => (
            <div key={i} className="act-row">
              <span className={`dot ${x.ok ? 'ok' : 'bad'}`} />
              <span>{x.side === 'buy' ? t.buy : t.sell} {x.asset}</span>
              <span className="muted">{x.ok ? `${x.amountIn} ${x.tokenIn} → ${Number(x.amountOut).toPrecision(6)} ${x.tokenOut}` : x.reason}</span>
              <span className="muted">{new Date(x.at).toLocaleString('en-US')}</span>
              {x.explorerUrl ? <a href={x.explorerUrl} target="_blank" rel="noreferrer">{short(x.txHash)} ↗</a> : <span />}
            </div>
          ))}
        </section>
      ) : (
        <section className="card empty">
          <div className="empty-title">{t.noTrades}</div>
          <div className="muted">{t.noTradesSub}</div>
        </section>
      )}
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
  const quotes = useQuotes();
  const { vault, reloadVault } = useVault();
  const { bots, add, remove } = useBots();
  const { execs, record } = useExecutions();
  const current = useMemo(() => (view.name === 'bot' ? bots.find((b) => b.id === view.id) : undefined), [view, bots]);
  const go = (v: View) => { setView(v); window.scrollTo(0, 0); };

  return (
    <LangContext.Provider value={{ lang, t, setLang }}>
      <div className="app">
        <TopNav view={view} go={go} botCount={bots.length} quotes={quotes} vault={vault} />
        <main className="main">
          {view.name === 'trade' && <Trade quotes={quotes} vault={vault} onAsk={(p) => go({ name: 'chat', prefill: p, auto: !!p })} />}
          {view.name === 'chat' && (
            <Chat
              key={(view.prefill ?? '') + String(view.auto)}
              prefill={view.prefill}
              auto={view.auto}
              quotes={quotes}
              vault={vault}
              onExecuted={(x) => { record(x); reloadVault(); }}
              onCreate={(goal, plan) => { const b = add({ name: botName(plan), goal, plan }); go({ name: 'bot', id: b.id }); }}
            />
          )}
          {view.name === 'bots' && <Bots bots={bots} go={go} execs={execs} />}
          {view.name === 'bot' && current && <BotDetail bot={current} execs={execs} vault={vault} onDelete={() => { remove(current.id); go({ name: 'bots' }); }} />}
        </main>
        <TabBar view={view} go={go} botCount={bots.length} />
      </div>
    </LangContext.Provider>
  );
}
