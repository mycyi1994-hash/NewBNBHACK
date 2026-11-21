// Moa, docked on the right of every screen. One conversation that survives page changes.
import { useEffect, useRef, useState } from 'react';
import { describe, parseIntent, scheduleOf, type Plan, type Step } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { reply } from './moa.ts';
import type { Execution } from './store.ts';
import { useT } from './i18n.ts';
import { MoaGlyph, coinName, type VaultInfo } from './parts.tsx';

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

const time = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmtAmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : v >= 1 ? 4 : 6 });
const EXECUTE = /(실행|execute)/i;

export function PlanSteps({ steps }: { steps: Step[] }) {
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

/** A fill confirmation: what was paid, what came back, at what price, with the on-chain proof. */
function Receipt({ x, at }: { x: Exec; at: number }) {
  const { t } = useT();
  const buy = x.request.side === 'buy';
  const inAmt = Number(x.amountIn), outAmt = Number(x.amountOut);
  const price = x.ok && inAmt > 0 && outAmt > 0 ? (buy ? inAmt / outAmt : outAmt / inAmt) : undefined;
  return (
    <div className={`receipt ${x.ok ? 'ok' : 'bad'}`}>
      <div className="receipt-top">
        <span className="receipt-status">{x.ok ? t.executed : t.notExecuted}</span>
        <time className="muted">{time(at)}</time>
      </div>
      {x.ok ? (
        <dl className="receipt-kv">
          <dt>{buy ? t.paid : t.sold}</dt><dd>{fmtAmt(inAmt)} {coinName(x.tokenIn)}</dd>
          <dt>{t.received}</dt><dd className={buy ? 'pos' : ''}>{fmtAmt(outAmt)} {coinName(x.tokenOut)}</dd>
          {price !== undefined && <><dt>{t.avgPrice}</dt><dd>${fmtPrice(price)}</dd></>}
          <dt>{t.poolFee}</dt><dd>0.3%</dd>
        </dl>
      ) : <div className="receipt-line">{buy ? t.buy : t.sell} {x.request.asset} ${x.request.amount} · {x.reason}</div>}
      {x.ok && x.explorerUrl && <a className="receipt-link" href={x.explorerUrl} target="_blank" rel="noreferrer">{t.viewTx} {short(x.txHash)} ↗</a>}
    </div>
  );
}

function MoaMark() {
  return <span className="moa-mark" aria-hidden><MoaGlyph size={13} /></span>;
}

function Progress({ steps, startedAt }: { steps: StepKey[]; startedAt: number }) {
  const { t } = useT();
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((v) => v + 1), 1000); return () => clearInterval(i); }, []);
  const secs = Math.round((Date.now() - startedAt) / 1000);
  return (
    <div className="msg moa fade-in" role="status" aria-live="polite">
      <div className="msg-meta"><MoaMark /><b>Moa</b><time>{secs}s</time></div>
      <ol className="progress">
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

export interface Seed { text: string; n: number }

export default function Assistant({ quotes, vault, seed, open, onClose, onCreate, onOpen, onExecuted }: {
  quotes: Quote[]; vault: VaultInfo | null; seed: Seed | null; open: boolean; onClose: () => void;
  onCreate: (goal: string, plan: Plan, since: number) => string; onOpen: (id: string) => void; onExecuted: (x: Execution[]) => void;
}) {
  const { t, lang } = useT();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState<{ steps: StepKey[]; at: number } | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState<boolean | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const lastReply = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A new reply is read from its first line: bring its header to the top. Anything else (progress,
    // a new plan state, the user's own message) goes to the end.
    // Recent Chromium returns a Promise from scrollIntoView; an effect must not return it.
    const last = msgs[msgs.length - 1];
    // Scroll only the panel: scrollIntoView would also move the page behind it.
    const box = body.current;
    if (!box) return;
    const top = !busy && last?.role === 'moa' && lastReply.current ? lastReply.current.offsetTop - 12 : box.scrollHeight;
    box.scrollTo({ top, behavior: 'smooth' });
  }, [msgs, busy]);
  useEffect(() => { if (createdId) body.current?.scrollTo({ top: body.current.scrollHeight, behavior: 'smooth' }); }, [createdId]);

  useEffect(() => {
    if (!seed) return;
    setDraft(seed.text);
    input.current?.focus();
  }, [seed]);

  const fill = (text: string) => { setDraft(text); input.current?.focus(); };

  const send = async (text: string) => {
    const tx = text.trim();
    if (!tx || busy) return;
    setDraft('');
    const history = [...msgs, { role: 'you' as const, text: tx, at: Date.now() }];
    setMsgs(history);
    setBusy({ steps: ['thinking'], at: Date.now() });
    const hadMissing = !!plan?.missing.length;
    const finish = (m: Msg, p: Plan | null, g: string) => {
      if (p && p.steps.length) {
        setPlan(p);
        // The bot keeps the user's goal sentence: an "execute" message or a follow-up answer never replaces it.
        if (!EXECUTE.test(g)) {
          setGoal((prev) => (prev && hadMissing ? `${prev}, ${g}` : g));
          if (!hadMissing) setCreatedId(null);
          setPlanOpen(null);
        }
      }
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
            setOnline(true);
            finish({ role: 'moa', text: res.reply, at: Date.now(), execs: res.executions?.length ? res.executions : undefined }, p, tx);
            return;
          }
        }
      }
      throw new Error('stream ended without a result');
    } catch {
      // No server (static hosting) or the API failed: fall back to the on-device parser, clearly marked.
      setOnline(false);
      const merged = plan && plan.missing.length && goal ? `${goal}, ${tx}` : tx;
      const p = parseIntent(merged);
      finish({ role: 'moa', text: reply(p, quotes, lang), at: Date.now(), offline: true }, p, merged);
    }
  };

  const executedHere = msgs.some((m) => m.execs?.some((x) => x.ok));
  // Once a buy has filled, the receipt is the news: fold the plan to one line unless the user opens it.
  const showSteps = planOpen ?? !executedHere;
  const spentToday = vault?.configured ? Math.max(0, Number(vault.maxDailyUsdt) - Number(vault.remainingTodayUsdt)) : 0;

  const reset = () => { setMsgs([]); setPlan(null); setCreatedId(null); setPlanOpen(null); setGoal(''); setDraft(''); input.current?.focus(); };

  return (
    <aside className={`assistant${open ? ' open' : ''}`} aria-label="Moa">
      <header className="as-head">
        <div className="as-title">
          <MoaMark />
          <b>Moa</b>
          <span className={`status-dot${online === false ? '' : ' on'}`}>{online === false ? t.aiOffline : t.aiOnline}</span>
        </div>
        <div className="as-actions">
          {msgs.length > 0 && <button className="btn-soft sm" onClick={reset}>{t.newChat}</button>}
          <button className="btn-soft sm mobile-only" onClick={onClose} aria-label={t.close}>✕</button>
        </div>
      </header>

      <div className="as-body" ref={body}>
        {msgs.length === 0 && !busy ? (
          <div className="as-empty fade-in">
            <h2 className="as-hero">{t.heroTitle}</h2>
            <p className="as-intro">{t.heroSub}</p>
            <div className="examples">
              {t.starters.slice(0, 3).map((s) => (
                <button key={s.title} className="example" onClick={() => fill(s.prompt)}>
                  <span className="chip">{s.title}</span>
                  <span className="example-text">{s.prompt}</span>
                  <span className="example-arrow" aria-hidden>↗</span>
                </button>
              ))}
            </div>
            <section className="protect">
              <b>{t.protectTitle}</b>
              <ul>
                <li><span className="tick" aria-hidden>✓</span>{vault?.configured ? t.protect1(vault.maxTradeUsdt ?? '?', vault.maxDailyUsdt ?? '?') : t.protect1none}</li>
                <li><span className="tick" aria-hidden>✓</span>{t.protect2}</li>
                <li><span className="tick" aria-hidden>✓</span>{t.protect3}</li>
              </ul>
            </section>
          </div>
        ) : (
          <>
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.role} fade-in`} ref={i === msgs.length - 1 ? lastReply : undefined}>
                {m.role === 'moa' && <div className="msg-meta"><MoaMark /><b>Moa</b><time>{time(m.at)}</time></div>}
                <div className="msg-text">{m.text}</div>
                {m.execs?.map((x, k) => <Receipt key={k} x={x} at={m.at} />)}
                {m.offline && <div className="offline">{t.offline}</div>}
              </div>
            ))}
            {busy && <Progress steps={busy.steps} startedAt={busy.at} />}
            {plan && !busy && (
              <section className="plan-card fade-in" aria-label={t.plan}>
                <button type="button" className="plan-head" onClick={() => setPlanOpen(!showSteps)} aria-expanded={showSteps}>
                  <b>{t.plan}</b><span className="muted">{t.planSteps(plan.steps.length)} <span className={`caret${showSteps ? ' up' : ''}`} aria-hidden>⌄</span></span>
                </button>
                {showSteps && (
                  <>
                    <PlanSteps steps={plan.steps} />
                    {plan.missing.length > 0 && <div className="needs">{t.needs} {plan.missing[0]}</div>}
                    <ul className="guards"><li>{t.guard1}</li><li>{t.guard2(((vault?.maxSlippageBps ?? 150) / 100).toFixed(1))}</li><li>{t.guard3}</li></ul>
                  </>
                )}
                {createdId ? (
                  <>
                    <div className="created">✓ {t.botCreated}</div>
                    <button className="btn-soft wide" onClick={() => onOpen(createdId)}>{t.openBot} →</button>
                  </>
                ) : (
                  <>
                    <button className="btn-primary wide" disabled={plan.missing.length > 0}
                      onClick={() => setCreatedId(onCreate(goal, plan, msgs[0]?.at ?? Date.now()))}>{t.createBot}</button>
                    {vault?.configured && plan.missing.length === 0 && !executedHere && plan.steps.some((s) => s.kind === 'accumulate') && (
                      <button className="btn-soft wide" onClick={() => fill(t.runFirstPrompt)}>{t.runFirst}</button>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        )}
        <div ref={end} />
      </div>

      <form className="as-composer" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
        <div className="composer-box">
          <textarea ref={input} rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder={msgs.length ? t.replyPlaceholder : t.dockPlaceholder} aria-label={t.messageMoa}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); } }} />
          <button className="send" type="submit" disabled={!draft.trim() || !!busy} aria-label={t.send}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
        {vault?.configured ? (
          <div className="as-foot">
            <div className="spend">
              <span>{t.spentToday}</span>
              <span className="spend-bar" aria-hidden><span style={{ width: `${Math.min(100, (spentToday / Math.max(1, Number(vault.maxDailyUsdt))) * 100)}%` }} /></span>
              <b>${spentToday.toFixed(0)} / ${vault.maxDailyUsdt}</b>
            </div>
            <div>{t.footRule(vault.maxTradeUsdt ?? '?')}</div>
          </div>
        ) : <div className="as-foot">{vault?.unreachable ? t.vaultDown : t.vaultNone}</div>}
      </form>
    </aside>
  );
}
