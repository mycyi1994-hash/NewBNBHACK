import { useEffect, useMemo, useRef, useState } from 'react';
import { botName, describe, parseIntent, scheduleOf, type Plan, type Step } from './intent.ts';
import { fmtPrice, loadQuotes, type Quote } from './market.ts';
import { EXAMPLES, GREETING, reply } from './moa.ts';
import { useBots, type Bot } from './store.ts';

type View = { name: 'home' } | { name: 'chat'; prefill?: string } | { name: 'bots' } | { name: 'bot'; id: string } | { name: 'markets' };
interface Msg { role: 'moa' | 'you'; text: string; at: number }

function useQuotes() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const tick = () => loadQuotes().then((q) => { if (alive) { setQuotes(q); setLoading(false); } });
    tick();
    const t = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { quotes, loading };
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
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
      {item('Home', { name: 'home' }, '⌂', view.name === 'home')}
      <div className="nav-label">ASSISTANT</div>
      {item('Ask Moa', { name: 'chat' }, '✦', view.name === 'chat')}
      <div className="nav-label">AUTOMATIONS</div>
      {item('Bots', { name: 'bots' }, '◎', view.name === 'bots' || view.name === 'bot', botCount)}
      <div className="nav-label">DATA</div>
      {item('Markets', { name: 'markets' }, '∿', view.name === 'markets')}
      <div className="sidebar-foot">
        <div className="net"><span className="live-dot" /> HSK Chain · mainnet</div>
        <div className="foot-note">Execution not enabled yet</div>
      </div>
    </aside>
  );
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

/* ---------- home ---------- */

const FEATURES = [
  { title: 'Collect', sub: 'Buy a little at a time', color: 'peach', icon: '◔', prompt: EXAMPLES[0] },
  { title: 'Protect', sub: 'Stop-loss and take-profit', color: 'lilac', icon: '◈', prompt: 'If HSK falls 15%, sell half' },
  { title: 'Earn', sub: 'Put idle USDT to work', color: 'sky', icon: '◍', prompt: 'Stake idle USDT' },
  { title: 'Set a goal', sub: 'Say the result you want', color: 'mint', icon: '◎', prompt: EXAMPLES[1] },
  { title: 'Ask anything', sub: 'Prices, plans, why', color: 'rose', icon: '✦', prompt: '' },
];

function Home({ go, quotes, loading, bots }: { go: (v: View) => void; quotes: Quote[]; loading: boolean; bots: Bot[] }) {
  return (
    <div className="page">
      <h1 className="hello">{greeting()}</h1>
      <div className="feature-row">
        {FEATURES.map((f) => (
          <button key={f.title} className="feature" onClick={() => go({ name: 'chat', prefill: f.prompt })}>
            <span className={`feature-icon ${f.color}`} aria-hidden>{f.icon}</span>
            <span className="feature-title">{f.title}</span>
            <span className="feature-sub">{f.sub}</span>
          </button>
        ))}
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Markets on HSKSwap</h2>
            <p className="muted">Pool price on HSK Chain next to the exchange price. Refreshes every 30 seconds.</p>
          </div>
          <button className="btn-ghost" onClick={() => go({ name: 'markets' })}>Details</button>
        </div>
        <QuoteTable quotes={quotes} loading={loading} />
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Your bots</h2>
            <p className="muted">Each bot owns one goal and works on it until it is done.</p>
          </div>
          <button className="btn-dark" onClick={() => go({ name: 'chat' })}>+ New bot</button>
        </div>
        {bots.length === 0 ? (
          <div className="empty">
            <div className="empty-title">No bots yet</div>
            <div className="muted">Tell Moa a goal like “{EXAMPLES[0]}”.</div>
          </div>
        ) : (
          <BotList bots={bots} go={go} />
        )}
      </section>
    </div>
  );
}

function QuoteTable({ quotes, loading }: { quotes: Quote[]; loading: boolean }) {
  if (loading) return <div className="muted pad">Reading HSK Chain…</div>;
  return (
    <table className="table">
      <thead>
        <tr><th>Asset</th><th>HSKSwap pool</th><th>Exchange (Gate)</th><th>24h</th><th>Gap</th></tr>
      </thead>
      <tbody>
        {quotes.map((q) => (
          <tr key={q.asset}>
            <td><span className={`coin coin-${q.asset.toLowerCase()}`}>{q.asset}</span></td>
            <td>{q.pool !== undefined ? `$${fmtPrice(q.pool)}` : <Unavailable why={q.poolSource} />}</td>
            <td>{q.exchange !== undefined ? `$${fmtPrice(q.exchange)}` : <Unavailable why={q.exchangeSource} />}</td>
            <td className={q.exchangeChange24h !== undefined && q.exchangeChange24h < 0 ? 'neg' : 'pos'}>
              {q.exchangeChange24h !== undefined ? `${q.exchangeChange24h > 0 ? '+' : ''}${q.exchangeChange24h.toFixed(2)}%` : '—'}
            </td>
            <td>{q.gap !== undefined ? <span className={`gap ${Math.abs(q.gap) >= 0.006 ? 'gap-wide' : ''}`}>{q.gap > 0 ? '+' : ''}{(q.gap * 100).toFixed(2)}%</span> : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Unavailable({ why }: { why: Quote['poolSource'] }) {
  return <span className="unavail" title={why.state === 'unavailable' ? why.reason : ''}>Unavailable</span>;
}

/* ---------- chat ---------- */

function Chat({ prefill, quotes, onCreate }: { prefill?: string; quotes: Quote[]; onCreate: (goal: string, plan: Plan) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'moa', text: GREETING, at: Date.now() }]);
  const [draft, setDraft] = useState(prefill ?? '');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [goal, setGoal] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Recent Chromium returns a Promise from scrollIntoView; an effect must not return it.
    void end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const merged = plan && plan.missing.length && goal ? `${goal}, ${t}` : t;
    const p = parseIntent(merged);
    setGoal(p.steps.length ? merged : goal);
    if (p.steps.length) setPlan(p);
    setMsgs((m) => [...m, { role: 'you', text: t, at: Date.now() }, { role: 'moa', text: reply(p, quotes), at: Date.now() }]);
    setDraft('');
  };

  return (
    <div className="chat-layout">
      <div className="chat-main">
        <div className="chat-scroll">
          <div className="event"><span className="event-dot ok" /> Conversation started <span className="event-time">{time(msgs[0].at)}</span></div>
          {msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              <div className="bubble-head">{m.role === 'moa' ? 'Moa' : 'You'}<span>{time(m.at)}</span></div>
              <div>{m.text}</div>
            </div>
          ))}
          {msgs.length === 1 && (
            <div className="examples">
              {EXAMPLES.map((e) => <button key={e} className="chip" onClick={() => send(e)}>{e}</button>)}
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="tip"><b>Tip:</b> say the result you want, not the steps. “Collect 5,000 HSK by Dec 31” works better than “buy HSK”.</div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Tell Moa a goal…" aria-label="Message Moa" />
          <button className="btn-dark" type="submit" disabled={!draft.trim()}>Send <span className="kbd">↵</span></button>
        </form>
      </div>
      <aside className="plan-panel">
        <div className="panel-label">Plan</div>
        {!plan ? (
          <div className="panel-empty">Moa turns your goal into steps here. Nothing runs until you create a bot.</div>
        ) : (
          <>
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
        )}
      </aside>
    </div>
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
      <section className="card">{bots.length ? <BotList bots={bots} go={go} /> : <div className="empty"><div className="empty-title">No bots yet</div><div className="muted">Create one from Ask Moa.</div></div>}</section>
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

/* ---------- markets ---------- */

function Markets({ quotes, loading }: { quotes: Quote[]; loading: boolean }) {
  return (
    <div className="page">
      <h1 className="hello">Markets</h1>
      <section className="card">
        <QuoteTable quotes={quotes} loading={loading} />
        <p className="muted small">Pool price is read directly from each HSKSwap pool contract on HSK Chain mainnet (chain 177). Exchange price is Gate spot. Gap = pool ÷ exchange − 1; HSKSwap charges 0.3% per swap.</p>
      </section>
    </div>
  );
}

/* ---------- app ---------- */

export default function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const { quotes, loading } = useQuotes();
  const { bots, add, remove } = useBots();
  const current = useMemo(() => (view.name === 'bot' ? bots.find((b) => b.id === view.id) : undefined), [view, bots]);
  const title = { home: 'Home', chat: 'Ask Moa', bots: 'Bots', bot: current?.name ?? 'Bot', markets: 'Markets' }[view.name];

  return (
    <div className="app">
      <Sidebar view={view} go={setView} botCount={bots.length} />
      <main className="main">
        <Topbar title={title} quotes={quotes} />
        {view.name === 'home' && <Home go={setView} quotes={quotes} loading={loading} bots={bots} />}
        {view.name === 'chat' && (
          <Chat
            key={view.prefill ?? 'blank'}
            prefill={view.prefill}
            quotes={quotes}
            onCreate={(goal, plan) => { const b = add({ name: botName(plan), goal, plan }); setView({ name: 'bot', id: b.id }); }}
          />
        )}
        {view.name === 'bots' && <Bots bots={bots} go={setView} />}
        {view.name === 'bot' && current && <BotDetail bot={current} onDelete={() => { remove(current.id); setView({ name: 'bots' }); }} />}
        {view.name === 'markets' && <Markets quotes={quotes} loading={loading} />}
      </main>
    </div>
  );
}
