import { useEffect, useMemo, useRef, useState } from 'react';
import { botName, describe, parseIntent, scheduleOf, type Plan, type Step } from './intent.ts';
import { fmtPrice, loadQuotes, type Quote } from './market.ts';
import { EXAMPLES, GREETING, reply } from './moa.ts';
import { useBots, type Bot } from './store.ts';
import Trade from './Trade.tsx';

type View = { name: 'trade' } | { name: 'chat'; prefill?: string; auto?: boolean } | { name: 'bots' } | { name: 'bot'; id: string };
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

const time = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

/* ---------- shell ---------- */

function Sidebar({ view, go, botCount }: { view: View; go: (v: View) => void; botCount: number }) {
  const item = (label: string, v: View, icon: string, active: boolean, badge?: number) => (
    <button className={`nav-item${active ? ' active' : ''}`} onClick={() => go(v)}>
      <span className="nav-icon" aria-hidden>{icon}</span>
      {label}
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </button>
  );
  return (
    <aside className="sidebar">
      <div className="brand"><span className="brand-dot" aria-hidden /> moa</div>
      <div className="nav-label">MARKETS</div>
      {item('Trade', { name: 'trade' }, '∿', view.name === 'trade')}
      <div className="nav-label">ASSISTANT</div>
      {item('Ask Moa', { name: 'chat' }, '✦', view.name === 'chat')}
      <div className="nav-label">AUTOMATIONS</div>
      {item('Bots', { name: 'bots' }, '◎', view.name === 'bots' || view.name === 'bot', botCount)}
      <div className="sidebar-foot">
        <div className="net"><span className="live-dot" /> HSK Chain</div>
        <VaultFoot />
      </div>
    </aside>
  );
}

/** Shows whether this server has a vault to execute through, from /api/vault. */
function VaultFoot() {
  const [v, setV] = useState<{ configured: boolean; vault?: string; usdtBalance?: string; remainingTodayUsdt?: string } | null>(null);
  useEffect(() => { fetch('/api/vault').then((r) => r.json()).then(setV).catch(() => setV({ configured: false })); }, []);
  if (!v) return null;
  if (!v.configured) return <div className="foot-note">No vault connected: execution off</div>;
  return <div className="foot-note">Vault {v.vault?.slice(0, 6)}…{v.vault?.slice(-4)} · {Number(v.usdtBalance).toFixed(2)} USDT · ${v.remainingTodayUsdt} left today</div>;
}

function Topbar({ title, quotes }: { title: string; quotes: Quote[] }) {
  const hsk = quotes.find((q) => q.asset === 'HSK');
  return (
    <header className="topbar">
      <div className="topbar-title">{title}</div>
      <div className="topbar-right">
        {hsk?.pool !== undefined && <span className="pill">HSK {fmtPrice(hsk.pool)}</span>}
        <span className="pill pill-soft">Preview</span>
      </div>
    </header>
  );
}

/* ---------- chat ---------- */

const STARTERS = [
  { title: 'Collect', sub: 'Buy a little at a time', color: 'peach', icon: '◔', prompt: EXAMPLES[0] },
  { title: 'Protect', sub: 'Stop-loss, take-profit', color: 'lilac', icon: '◈', prompt: 'If HSK falls 15%, sell half' },
  { title: 'Earn', sub: 'Put idle USDT to work', color: 'sky', icon: '◍', prompt: EXAMPLES[2] },
  { title: 'Set a goal', sub: 'Say the result you want', color: 'mint', icon: '◎', prompt: EXAMPLES[1] },
];

/** Reveals text a few characters at a time, like someone typing. */
function Typing({ text, onDone }: { text: string; onDone: () => void }) {
  const [n, setN] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const step = Math.max(2, Math.round(text.length / 90));
    const t = setInterval(() => setN((v) => {
      const next = Math.min(text.length, v + step);
      if (next === text.length) { clearInterval(t); done.current(); }
      return next;
    }), 16);
    return () => clearInterval(t);
  }, [text]);
  return <>{text.slice(0, n)}<span className="caret" aria-hidden /></>;
}

function Chat({ prefill, auto, quotes, onCreate }: { prefill?: string; auto?: boolean; quotes: Quote[]; onCreate: (goal: string, plan: Plan) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState(auto ? '' : prefill ?? '');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [goal, setGoal] = useState('');
  const [thinking, setThinking] = useState(false);
  const [typingIdx, setTypingIdx] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const started = msgs.length > 0;

  useEffect(() => {
    // Recent Chromium returns a Promise from scrollIntoView; an effect must not return it.
    void end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, thinking]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || thinking) return;
    setDraft('');
    const history = [...msgs, { role: 'you' as const, text: t, at: Date.now() }];
    setMsgs(history);
    setThinking(true);
    const finish = (m: Msg, p: Plan | null, g: string) => {
      if (p && p.steps.length) { setPlan(p); setGoal(g); }
      setThinking(false);
      setMsgs((cur) => { setTypingIdx(cur.length); return [...cur, m]; });
    };
    fetch('/api/moa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: history.map((m) => ({ role: m.role === 'you' ? 'user' : 'assistant', content: m.text })) }),
    })
      .then(async (r) => {
        const j = (await r.json()) as { reply?: string; plan?: { steps: ServerStep[]; missing: string[] }; executions?: Exec[]; error?: string };
        if (!r.ok || !j.reply) throw new Error(j.error ?? `HTTP ${r.status}`);
        const p = j.plan ? { steps: j.plan.steps.map(toStep), missing: j.plan.missing } : null;
        finish({ role: 'moa', text: j.reply, at: Date.now(), execs: j.executions?.length ? j.executions : undefined }, p, t);
      })
      .catch(() => {
        // No server (static hosting) or the API failed: fall back to the on-device parser, clearly marked.
        const merged = plan && plan.missing.length && goal ? `${goal}, ${t}` : t;
        const p = parseIntent(merged);
        finish({ role: 'moa', text: reply(p, quotes), at: Date.now(), offline: true }, p, merged);
      });
  };

  const sentAuto = useRef(false);
  useEffect(() => {
    if (auto && prefill && !sentAuto.current) { sentAuto.current = true; send(prefill); }
  });

  const composer = (big: boolean) => (
    <form className={`composer${big ? ' big' : ''}`} onSubmit={(e) => { e.preventDefault(); send(draft); }}>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={big ? 'Collect 5,000 HSK by Dec 31, stop if it drops 15%…' : 'Reply to Moa…'} aria-label="Message Moa" autoFocus />
      <button className="btn-dark" type="submit" disabled={!draft.trim() || thinking}>Send <span className="kbd">↵</span></button>
    </form>
  );

  return (
    <div className="chat-layout">
      <div className="chat-main">
        {!started ? (
          <div className="hero">
            <span className="moa-avatar xl" aria-hidden />
            <h1>What should Moa do with your money?</h1>
            <p className="muted">{GREETING}</p>
            {composer(true)}
            <div className="starter-row">
              {STARTERS.map((s) => (
                <button key={s.title} className="starter" onClick={() => send(s.prompt)}>
                  <span className={`feature-icon sm ${s.color}`} aria-hidden>{s.icon}</span>
                  <span><b>{s.title}</b><span className="muted">{s.sub}</span></span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="chat-scroll">
              <div className="chat-col">
                <div className="event"><span className="event-dot ok" /> Conversation started <span className="event-time">{time(msgs[0].at)}</span></div>
                {msgs.map((m, i) => (
                  <div key={i} className={`msg ${m.role}`}>
                    {m.role === 'moa' && <span className="moa-avatar" aria-hidden />}
                    <div className={`bubble ${m.role}`}>
                      <div className="bubble-head">{m.role === 'moa' ? 'Moa' : 'You'}<span>{time(m.at)}</span></div>
                      <div className="bubble-text">{m.role === 'moa' && i === typingIdx ? <Typing text={m.text} onDone={() => setTypingIdx(null)} /> : m.text}</div>
                      {m.execs?.map((x, k) => <Receipt key={k} x={x} />)}
                      {m.offline && <div className="offline">Offline mode: Moa’s AI is not reachable, so this reply came from the on-device parser.</div>}
                    </div>
                  </div>
                ))}
                {thinking && (
                  <div className="msg moa">
                    <span className="moa-avatar pulse" aria-hidden />
                    <div className="bubble moa thinking"><span /><span /><span /> <em>Moa is thinking…</em></div>
                  </div>
                )}
                <div ref={end} />
              </div>
            </div>
            <div className="chat-col bottom">{composer(false)}</div>
          </>
        )}
      </div>
      <aside className="plan-panel">
        {plan ? (
          <>
            <div className="panel-label">Plan</div>
            <PlanSteps steps={plan.steps} />
            {plan.missing.length > 0 && <div className="needs">Needs your answer: {plan.missing[0]}</div>}
            <div className="panel-label">Guardrails</div>
            <ul className="guards">
              <li>Trades only on HSKSwap, only the coins in this plan</li>
              <li>Skips a buy when the pool is far above the exchange price</li>
              <li>Asks you before anything outside the plan</li>
            </ul>
            <button className="btn-dark wide" disabled={plan.missing.length > 0} onClick={() => onCreate(goal, plan)}>Create bot</button>
          </>
        ) : (
          <MoaSees quotes={quotes} />
        )}
      </aside>
    </div>
  );
}

function Receipt({ x }: { x: Exec }) {
  const side = x.request.side === 'buy' ? 'Buy' : 'Sell';
  return x.ok ? (
    <div className="receipt ok">
      <div className="receipt-head"><span className="dot ok" /> Executed on HSK Chain</div>
      <div className="receipt-line">{side} {x.request.asset}: {x.amountIn} {x.tokenIn} → {Number(x.amountOut).toPrecision(6)} {x.tokenOut}</div>
      <a href={x.explorerUrl} target="_blank" rel="noreferrer">{x.txHash?.slice(0, 10)}…{x.txHash?.slice(-6)} ↗</a>
    </div>
  ) : (
    <div className="receipt bad">
      <div className="receipt-head"><span className="dot bad" /> Not executed</div>
      <div className="receipt-line">{side} {x.request.amount} {x.request.side === 'buy' ? 'USDT of' : ''} {x.request.asset}: {x.reason}</div>
    </div>
  );
}

function MoaSees({ quotes }: { quotes: Quote[] }) {
  return (
    <>
      <div className="panel-label"><span className="live-dot" /> What Moa sees now</div>
      <div className="sees">
        {quotes.length === 0 && <div className="muted">Reading HSK Chain…</div>}
        {quotes.map((q) => (
          <div key={q.asset} className="sees-row">
            <span className={`coin coin-${q.asset.toLowerCase()}`}>{q.asset}</span>
            <span className="sees-price">{q.pool !== undefined ? `$${fmtPrice(q.pool)}` : 'Unavailable'}</span>
            {q.gap !== undefined && <span className={`gap ${Math.abs(q.gap) >= 0.006 ? 'gap-wide' : ''}`}>{q.gap > 0 ? '+' : ''}{(q.gap * 100).toFixed(2)}%</span>}
            <span className="sees-take muted">
              {q.gap === undefined ? '' : Math.abs(q.gap) < 0.003 ? 'In line with exchanges' : q.gap > 0 ? 'Pool is pricey: wait to buy' : 'Pool is cheap: good time to collect'}
            </span>
          </div>
        ))}
      </div>
      <p className="muted small">HSKSwap pool price vs Gate spot. Your plan appears here once you tell Moa a goal.</p>
    </>
  );
}

function PlanSteps({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps">
      {steps.map((s, i) => {
        const sch = s.kind === 'accumulate' ? scheduleOf(s) : {};
        return (
          <li key={i} className={`step step-${s.kind}`}>
            <span className="step-tag">{{ accumulate: 'Collect', stopLoss: 'Protect', takeProfit: 'Take profit', earn: 'Earn' }[s.kind]}</span>
            <span>{describe(s)}</span>
            {sch.buys !== undefined && <span className="step-meta">{sch.buys} buys · ${sch.totalUsd?.toLocaleString('en-US')} total</span>}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- bots ---------- */

function BotList({ bots, go }: { bots: Bot[]; go: (v: View) => void }) {
  return (
    <div className="bot-list">
      {bots.map((b) => (
        <button key={b.id} className="bot-row" onClick={() => go({ name: 'bot', id: b.id })}>
          <span className="bot-avatar" aria-hidden>{b.name.slice(0, 1)}</span>
          <span className="bot-text">
            <span className="bot-name">{b.name}</span>
            <span className="muted ellipsis">{b.goal}</span>
          </span>
          <span className="status draft">Draft</span>
        </button>
      ))}
    </div>
  );
}

function Bots({ bots, go }: { bots: Bot[]; go: (v: View) => void }) {
  return (
    <div className="page">
      <div className="card-head">
        <div>
          <h1 className="hello">Bots</h1>
          <p className="muted">Each bot holds one goal. Drafts run once the vault contract is live on HSK mainnet.</p>
        </div>
        <button className="btn-dark" onClick={() => go({ name: 'chat' })}>+ New bot</button>
      </div>
      <section className="card">{bots.length ? <BotList bots={bots} go={go} /> : <div className="empty"><div className="empty-title">No bots yet</div><div className="muted">Tell Moa a goal like “{EXAMPLES[0]}”.</div></div>}</section>
    </div>
  );
}

function BotDetail({ bot, onDelete }: { bot: Bot; onDelete: () => void }) {
  const [tab, setTab] = useState<'overview' | 'activity'>('overview');
  return (
    <div className="page narrow">
      <div className="card-head">
        <div>
          <h1 className="hello">{bot.name}</h1>
          <p className="muted">Created {new Date(bot.createdAt).toLocaleString('en-US')}</p>
        </div>
        <div className="row-gap">
          <span className="status draft">Draft · not deployed</span>
          <button className="btn-ghost" onClick={onDelete}>Delete</button>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
      </div>
      {tab === 'overview' ? (
        <section className="card">
          <div className="panel-label">Goal</div>
          <p className="goal">“{bot.goal}”</p>
          <div className="panel-label">Plan</div>
          <PlanSteps steps={bot.plan.steps} />
        </section>
      ) : (
        <section className="card empty">
          <div className="empty-title">No trades yet</div>
          <div className="muted">Every buy, sell and skipped buy will appear here with Moa’s reason and the HSK Chain transaction.</div>
        </section>
      )}
    </div>
  );
}

/* ---------- app ---------- */

export default function App() {
  const [view, setView] = useState<View>({ name: 'trade' });
  const quotes = useQuotes();
  const { bots, add, remove } = useBots();
  const current = useMemo(() => (view.name === 'bot' ? bots.find((b) => b.id === view.id) : undefined), [view, bots]);
  const title = { trade: 'Trade', chat: 'Ask Moa', bots: 'Bots', bot: current?.name ?? 'Bot' }[view.name];

  return (
    <div className="app">
      <Sidebar view={view} go={setView} botCount={bots.length} />
      <main className="main">
        <Topbar title={title} quotes={quotes} />
        {view.name === 'trade' && <Trade onAsk={(p) => setView({ name: 'chat', prefill: p, auto: !!p })} />}
        {view.name === 'chat' && (
          <Chat
            key={(view.prefill ?? '') + String(view.auto)}
            prefill={view.prefill}
            auto={view.auto}
            quotes={quotes}
            onCreate={(goal, plan) => { const b = add({ name: botName(plan), goal, plan }); setView({ name: 'bot', id: b.id }); }}
          />
        )}
        {view.name === 'bots' && <Bots bots={bots} go={setView} />}
        {view.name === 'bot' && current && <BotDetail bot={current} onDelete={() => { remove(current.id); setView({ name: 'bots' }); }} />}
      </main>
    </div>
  );
}
