import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { botName, describe, parseIntent, scheduleOf, type Plan, type Step } from './intent.ts';
import { fmtPrice, loadQuotes, type Quote } from './market.ts';
import { GREETING, reply } from './moa.ts';
import { useBots, useExecutions, type Bot, type Execution } from './store.ts';
import { LangContext, STRINGS, initialLang, saveLang, useT, type Lang } from './i18n.ts';
import Trade from './Trade.tsx';
import { MoaSees, TrustCard, type VaultInfo } from './parts.tsx';
import { CopyButton, Menu, Modal, RichText, ToastProvider, useToast } from './ui.tsx';

/**
 * The API conversation must start with the user. When Moa opened the conversation (its note on the trade
 * screen), fold that note into the user's first message as quoted context instead of sending it as a turn.
 */
function toApiHistory(history: { role: 'moa' | 'you'; text: string }[]) {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  let lead: string[] = [];
  for (const m of history) {
    if (!out.length && m.role === 'moa') { lead.push(m.text); continue; }
    const content = lead.length && m.role === 'you' ? `(Moa said earlier: “${lead.join(' ')}”)\n\n${m.text}` : m.text;
    lead = [];
    out.push({ role: m.role === 'you' ? 'user' : 'assistant', content });
  }
  return out;
}

/** Same words the server checks before it lets Moa trade. */
const EXECUTE_WORDS = /(실행|execute)/i;

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

function Sidebar({ view, go, botCount, vault }: { view: View; go: (v: View) => void; botCount: number; vault: VaultInfo | null }) {
  const { t } = useT();
  const item = (label: string, v: View, icon: string, active: boolean, badge?: number) => (
    <button className={`nav-item${active ? ' active' : ''}`} onClick={() => go(v)} aria-current={active ? 'page' : undefined}>
      <span className="nav-icon" aria-hidden>{icon}</span>
      {label}
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </button>
  );
  return (
    <aside className="sidebar">
      <div className="brand"><span className="orb sm" aria-hidden /> moa</div>
      <div className="nav-label">{t.navMarkets}</div>
      {item(t.navTrade, { name: 'trade' }, '∿', view.name === 'trade')}
      <div className="nav-label">{t.navAssistant}</div>
      {item(t.navAsk, { name: 'chat' }, '✦', view.name === 'chat')}
      <div className="nav-label">{t.navAutomations}</div>
      {item(t.navBots, { name: 'bots' }, '◎', view.name === 'bots' || view.name === 'bot', botCount)}
      <div className="sidebar-foot">
        <div className="net"><span className="live-dot" /> HSK Chain</div>
        {vault && <div className="foot-note">{vault.configured ? t.vaultOn(short(vault.vault), Number(vault.usdtBalance).toFixed(2), vault.remainingTodayUsdt ?? '0') : t.vaultNone}</div>}
      </div>
    </aside>
  );
}

function TabBar({ view, go, botCount }: { view: View; go: (v: View) => void; botCount: number }) {
  const { t } = useT();
  const tab = (label: string, v: View, icon: string, active: boolean, badge?: number) => (
    <button className={`tab${active ? ' on' : ''}`} onClick={() => go(v)} aria-current={active ? 'page' : undefined}>
      <span className="tab-icon" aria-hidden>{icon}</span>{label}{badge ? <span className="nav-badge">{badge}</span> : null}
    </button>
  );
  return (
    <nav className="tabbar" aria-label="Main">
      {tab(t.navTrade, { name: 'trade' }, '∿', view.name === 'trade')}
      {tab(t.navAsk, { name: 'chat' }, '✦', view.name === 'chat')}
      {tab(t.navBots, { name: 'bots' }, '◎', view.name === 'bots' || view.name === 'bot', botCount)}
    </nav>
  );
}

function Topbar({ title, quotes }: { title: string; quotes: Quote[] }) {
  const { t, lang, setLang } = useT();
  const hsk = quotes.find((q) => q.asset === 'HSK');
  return (
    <header className="topbar">
      <div className="topbar-title"><span className="brand mobile-only"><span className="orb sm" aria-hidden /> moa</span><span className="desktop-only">{title}</span></div>
      <div className="topbar-right">
        {hsk?.pool !== undefined && <span className="pill">HSK {fmtPrice(hsk.pool)}</span>}
        <button className="pill lang" onClick={() => setLang(lang === 'en' ? 'ko' : 'en')} aria-label="Switch language" data-tip={lang === 'en' ? '한국어로 보기' : 'View in English'}>{t.langLabel}</button>
      </div>
    </header>
  );
}

/* ---------- shared Moa pieces ---------- */

/** Reveals text a few characters at a time, like someone typing. */
function Typing({ text, onDone }: { text: string; onDone: () => void }) {
  const [n, setN] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const step = Math.max(2, Math.round(text.length / 90));
    const tm = setInterval(() => setN((v) => {
      const next = Math.min(text.length, v + step);
      if (next === text.length) { clearInterval(tm); done.current(); }
      return next;
    }), 16);
    return () => clearInterval(tm);
  }, [text]);
  return <>{text.slice(0, n)}<span className="caret" aria-hidden /></>;
}

function Receipt({ x }: { x: Exec }) {
  const { t } = useT();
  const side = x.request.side === 'buy' ? t.buy : t.sell;
  return x.ok ? (
    <div className="receipt ok">
      <div className="receipt-head"><span className="dot ok" /> {t.executed}</div>
      <div className="receipt-line">{side} {x.request.asset}: {x.amountIn} {x.tokenIn} → {Number(x.amountOut).toPrecision(6)} {x.tokenOut}</div>
      <a href={x.explorerUrl} target="_blank" rel="noreferrer">{short(x.txHash)} ↗</a>
    </div>
  ) : (
    <div className="receipt bad">
      <div className="receipt-head"><span className="dot bad" /> {t.notExecuted}</div>
      <div className="receipt-line">{side} {x.request.asset} {x.request.amount}: {x.reason}</div>
    </div>
  );
}

function Progress({ steps, startedAt }: { steps: StepKey[]; startedAt: number }) {
  const { t } = useT();
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((v) => v + 1), 1000); return () => clearInterval(i); }, []);
  const secs = Math.round((Date.now() - startedAt) / 1000);
  return (
    <div className="bubble moa progress" role="status" aria-live="polite">
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={i === steps.length - 1 ? 'now' : 'done'}>
            <span className="pmark" aria-hidden>{i === steps.length - 1 ? <span className="spinner" /> : '✓'}</span>
            {t.steps[s]}
          </li>
        ))}
      </ol>
      <span className="elapsed">{secs}s</span>
    </div>
  );
}

/* ---------- chat ---------- */

function Chat({ seed, active, quotes, vault, onCreate, onExecuted }: {
  seed: { text: string; ctx?: string; n: number } | null; active: boolean; quotes: Quote[]; vault: VaultInfo | null;
  onCreate: (goal: string, plan: Plan) => void; onExecuted: (x: Execution[]) => void;
}) {
  const { t, lang } = useT();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState<{ steps: StepKey[]; at: number } | null>(null);
  const [typingIdx, setTypingIdx] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const started = msgs.length > 0;

  // Follow new messages only while the reader is at the bottom; if they scrolled up, offer a jump button instead.
  const toBottom = (smooth = true) => { const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };
  useEffect(() => { if (atBottom) toBottom(); }, [msgs, busy, typingIdx]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = () => { const el = scroller.current; if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80); };

  // The input grows with its text, up to a limit (ChatGPT).
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; }, [draft]);

  const toast = useToast();
  const [confirm, setConfirm] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  /** A message that can move money gets a confirm step first (ChatGPT-style dialog). */
  const ask = (text: string) => {
    const tx = text.trim();
    if (!tx || busy) return;
    if (EXECUTE_WORDS.test(tx) && vault?.configured) { setConfirm(tx); return; }
    void send(tx);
  };

  const stop = () => {
    abort.current?.abort();
    abort.current = null;
    setBusy(null);
    setMsgs((cur) => [...cur, { role: 'moa', text: t.stopped, at: Date.now() }]);
  };

  const send = async (text: string, base: Msg[] = msgs) => {
    const tx = text.trim();
    if (!tx || busy) return;
    setDraft('');
    setAtBottom(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const history = [...base, { role: 'you' as const, text: tx, at: Date.now() }];
    setMsgs(history);
    setBusy({ steps: ['thinking'], at: Date.now() });
    const finish = (m: Msg, p: Plan | null, g: string) => {
      if (p && p.steps.length) { setPlan(p); setGoal(g); }
      setBusy(null);
      setMsgs((cur) => { setTypingIdx(cur.length); return [...cur, m]; });
    };
    try {
      const r = await fetch('/api/moa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history: toApiHistory(history) }),
        signal: ctrl.signal,
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
      if (ctrl.signal.aborted) return; // the user pressed stop; nothing more to show
      // No server (static hosting) or the API failed: fall back to the on-device parser, clearly marked.
      const merged = plan && plan.missing.length && goal ? `${goal}, ${tx}` : tx;
      const p = parseIntent(merged);
      finish({ role: 'moa', text: reply(p, quotes, lang), at: Date.now(), offline: true }, p, merged);
    }
  };

  /** Regenerate: drop the reply and the question it answered, then ask again (ChatGPT). */
  const retry = (i: number) => {
    const q = msgs[i - 1];
    if (!q || q.role !== 'you' || busy) return;
    const base = msgs.slice(0, i - 1);
    setMsgs(base);
    // A retried "execute" message is still a trade: it gets the same confirm dialog as a typed one.
    if (EXECUTE_WORDS.test(q.text) && vault?.configured) { setConfirm(q.text); return; }
    void send(q.text, base);
  };

  // Esc stops a reply; "/" jumps to the input from anywhere on the page (ChatGPT / Perplexity shortcuts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === 'Escape' && busy && !busy.steps.includes('execute') && !confirm) stop();
      else if (e.key === '/' && !typing && !confirm) { e.preventDefault(); input.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // A goal sent from the trade-screen dock joins this conversation; it does not wipe it (ChatGPT keeps history).
  const seen = useRef(0);
  useEffect(() => {
    if (!seed || seed.n === seen.current) return;
    seen.current = seed.n;
    if (!seed.text) { input.current?.focus(); return; }
    // Replying to something Moa said on the trade screen: start the conversation with that note, so the reply has context.
    if (seed.ctx && msgs.length === 0) {
      const base: Msg[] = [{ role: 'moa', text: seed.ctx, at: Date.now() }];
      setMsgs(base);
      if (EXECUTE_WORDS.test(seed.text) && vault?.configured) setConfirm(seed.text);
      else void send(seed.text, base);
      return;
    }
    ask(seed.text);
  });
  useEffect(() => { if (active) input.current?.focus(); }, [active]);

  /** ChatGPT "New chat": clear the conversation and the plan. */
  const newChat = () => { if (busy) return; setMsgs([]); setPlan(null); setGoal(''); setDraft(''); setTypingIdx(null); input.current?.focus(); };

  // Stop is offered while Moa thinks, but not once a trade is on its way to the vault (it may already be on-chain).
  const canStop = !!busy && !busy.steps.includes('execute');
  const composer = (big: boolean) => (
    <form className={`composer${big ? ' big' : ''}`} onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
      <textarea ref={input} rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={big ? t.heroPlaceholder : t.replyPlaceholder} aria-label="Message Moa" autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(draft); } }} />
      {busy ? (
        <button className="send-btn stop" type="button" onClick={stop} disabled={!canStop} aria-label={t.stop} data-tip={canStop ? `${t.stop} (Esc)` : t.stopLocked}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" /></svg>
        </button>
      ) : (
        <button className="send-btn" type="submit" disabled={!draft.trim()} aria-label={t.send} data-tip={`${t.send} (Enter)`}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
    </form>
  );

  return (
    <div className="chat-layout">
      {confirm && (
        <Modal
          title={t.confirmTitle}
          onClose={() => setConfirm(null)}
          actions={<>
            <button className="btn-ghost" onClick={() => setConfirm(null)}>{t.cancel}</button>
            <button className="btn-primary" onClick={() => { const x = confirm; setConfirm(null); void send(x); }}>{t.executeBtn}</button>
          </>}
        >
          <p className="modal-quote">“{confirm}”</p>
          <p>{t.confirmBody(vault?.maxTradeUsdt ?? '?', vault?.remainingTodayUsdt ?? '?')}</p>
        </Modal>
      )}
      <div className="chat-main">
        {!started ? (
          <div className="hero">
            <span className="orb xl breathe" aria-hidden />
            <h1>{t.heroTitle}</h1>
            <p className="muted">{lang === 'ko' ? t.dockSub : GREETING}</p>
            {composer(true)}
            <div className="starter-row">
              {t.starters.map((s, i) => (
                <button key={s.title} className="starter" onClick={() => ask(s.prompt)}>
                  <span className={`feature-icon sm ${['peach', 'lilac', 'sky', 'mint'][i]}`} aria-hidden>{['◔', '◈', '◍', '◎'][i]}</span>
                  <span><b>{s.title}</b><span className="muted">{s.sub}</span></span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
              <div className="chat-col">
                <div className="event"><span className="event-dot" /> {t.started} <span className="event-time">{time(msgs[0].at)}</span>
                  <button className="new-chat" onClick={newChat} disabled={!!busy} data-tip={t.newChatTip}>
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M11.5 2.5 13.5 4.5 7 11l-2.7.7.7-2.7 6.5-6.5zM3 13.5h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>{t.newChat}
                  </button>
                </div>
                {msgs.map((m, i) => (
                  <div key={i} className={`msg ${m.role}`}>
                    {m.role === 'moa' && <span className="orb md" aria-hidden />}
                    <div className={`bubble ${m.role}`}>
                      <div className="bubble-head">{m.role === 'moa' ? 'Moa' : t.you}<span>{time(m.at)}</span></div>
                      <div className="bubble-text">{m.role === 'moa' && i === typingIdx ? <Typing text={m.text} onDone={() => setTypingIdx(null)} /> : m.role === 'moa' ? <RichText text={m.text} /> : m.text}</div>
                      {m.execs?.map((x, k) => <Receipt key={k} x={x} />)}
                      {m.offline && <div className="offline">{t.offline}</div>}
                    </div>
                    {m.role === 'moa' && i !== typingIdx && (
                      <div className="msg-actions">
                        <CopyButton text={m.text} label={t.copy} done={t.copied} />
                        {m.offline && <button className="icon-btn sm" onClick={() => retry(i)} aria-label={t.retry} data-tip={t.retry}><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
                      </div>
                    )}
                  </div>
                ))}
                {busy && (
                  <div className="msg moa">
                    <span className="orb md spin" aria-hidden />
                    <Progress steps={busy.steps} startedAt={busy.at} />
                  </div>
                )}
                <div ref={end} />
              </div>
            </div>
            <div className="chat-col bottom">
              {!atBottom && <button className="jump" onClick={() => toBottom()} aria-label={t.toLatest} data-tip={t.toLatest}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
              {composer(false)}
            </div>
          </>
        )}
      </div>
      <aside className="plan-panel">
        {plan ? (
          <>
            <div className="panel-label">{t.plan}</div>
            <PlanSteps steps={plan.steps} />
            {plan.missing.length > 0 && <div className="needs">{t.needs} {plan.missing[0]}</div>}
            <div className="panel-label">{t.guardrails}</div>
            <ul className="guards"><li>{t.guard1}</li><li>{t.guard2}</li><li>{t.guard3}</li></ul>
            <button className="btn-primary wide" disabled={plan.missing.length > 0} onClick={() => { onCreate(goal, plan); toast(t.botCreatedToast); }}>{t.createBot}</button>
          </>
        ) : (
          <MoaSees quotes={quotes} />
        )}
        <TrustCard vault={vault} />
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
    <div className="bot-list">
      {bots.map((b) => {
        const spent = botExecs(b, execs).filter((x) => x.ok && x.side === 'buy').reduce((s, x) => s + x.amount, 0);
        const budget = botBudget(b);
        return (
          <button key={b.id} className="bot-row" onClick={() => go({ name: 'bot', id: b.id })}>
            <span className="bot-avatar" aria-hidden>{b.name.slice(0, 1)}</span>
            <span className="bot-text">
              <span className="bot-name">{b.name}</span>
              <span className="muted ellipsis">{b.goal}</span>
              {budget !== undefined && <span className="mini-bar" aria-hidden><span style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} /></span>}
            </span>
            <span className="status draft">{t.draft}</span>
          </button>
        );
      })}
    </div>
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
            <span className="orb lg breathe" aria-hidden />
            <div className="empty-title">{t.noBots}</div>
            <div className="muted">{t.noBotsSub}</div>
            <button className="btn-primary" onClick={() => go({ name: 'chat' })}>{t.askMoa}</button>
          </div>
        )}
      </section>
    </div>
  );
}

function BotDetail({ bot, onDelete, execs, vault }: { bot: Bot; onDelete: () => void; execs: Execution[]; vault: VaultInfo | null }) {
  const { t } = useT();
  const [tab, setTab] = useState<'overview' | 'activity'>('overview');
  const [askDelete, setAskDelete] = useState(false);
  const toast = useToast();
  const mine = botExecs(bot, execs);
  const spent = mine.filter((x) => x.ok && x.side === 'buy').reduce((s, x) => s + x.amount, 0);
  const budget = botBudget(bot);
  return (
    <div className="page narrow">
      {askDelete && (
        <Modal
          title={t.deleteTitle}
          onClose={() => setAskDelete(false)}
          actions={<>
            <button className="btn-ghost" onClick={() => setAskDelete(false)}>{t.cancel}</button>
            <button className="btn-danger" onClick={() => { setAskDelete(false); onDelete(); toast(t.botDeleted); }}>{t.delete}</button>
          </>}
        >
          <p><b>{bot.name}</b> {t.deleteBody}</p>
        </Modal>
      )}
      <div className="card-head">
        <div className="row-gap">
          <span className="bot-avatar lg" aria-hidden>{bot.name.slice(0, 1)}</span>
          <div>
            <h1 className="hello">{bot.name}</h1>
            <p className="muted">{t.created} {new Date(bot.createdAt).toLocaleDateString('en-US')}</p>
          </div>
        </div>
        <div className="row-gap">
          <span className="status draft">{t.draft}</span>
          <Menu label={t.more} items={[{ label: t.delete, danger: true, onSelect: () => setAskDelete(true) }]} />
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
  const [seed, setSeed] = useState<{ text: string; ctx?: string; n: number } | null>(null);
  const quotes = useQuotes();
  const { vault, reloadVault } = useVault();
  const { bots, add, remove } = useBots();
  const { execs, record } = useExecutions();
  const current = useMemo(() => (view.name === 'bot' ? bots.find((b) => b.id === view.id) : undefined), [view, bots]);
  const title = { trade: t.navTrade, chat: t.navAsk, bots: t.navBots, bot: current?.name ?? t.navBots }[view.name];
  const go = (v: View) => { setView(v); window.scrollTo(0, 0); };

  return (
    <LangContext.Provider value={{ lang, t, setLang }}>
      <ToastProvider>
      <div className="app">
        <Sidebar view={view} go={go} botCount={bots.length} vault={vault} />
        <main className="main">
          <Topbar title={title} quotes={quotes} />
          {view.name === 'trade' && <Trade quotes={quotes} vault={vault} onAsk={(p, ctx) => { setSeed((x) => ({ text: p, ctx, n: (x?.n ?? 0) + 1 })); go({ name: 'chat' }); }} />}
          {/* Chat stays mounted so the conversation survives page changes; it is only hidden. */}
          <div className="chat-host" hidden={view.name !== 'chat'}>
            <Chat
              seed={seed}
              active={view.name === 'chat'}
              quotes={quotes}
              vault={vault}
              onExecuted={(x) => { record(x); reloadVault(); }}
              onCreate={(goal, plan) => { const b = add({ name: botName(plan), goal, plan }); go({ name: 'bot', id: b.id }); }}
            />
          </div>
          {view.name === 'bots' && <Bots bots={bots} go={go} execs={execs} />}
          {view.name === 'bot' && current && <BotDetail bot={current} execs={execs} vault={vault} onDelete={() => { remove(current.id); go({ name: 'bots' }); }} />}
        </main>
        <TabBar view={view} go={go} botCount={bots.length} />
      </div>
      </ToastProvider>
    </LangContext.Provider>
  );
}
