// Moa on the right of the trade screen: a conversation that stays here.
// Opens instantly (never waits on data): a short greeting, a live market brief, and "start with" cards
// for the market you are looking at. You ask, Moa answers in this panel (same server brain as the Ask Moa
// page, with live progress steps); plans can become bots and trades show their receipts, all without
// leaving the chart. A tapped strategy arrives as a full card. Every number comes from live data.
import { useEffect, useRef, useState } from 'react';
import type { Quote } from './market.ts';
import { useT } from './i18n.ts';
import { RollNum, SlidePill } from './motion.tsx';
import type { VaultInfo } from './parts.tsx';
import { CopyAddress, CopyButton, Modal, RichText } from './ui.tsx';
import type { StratNote } from './Strategies.tsx';
import { askMoa, EXECUTE_WORDS, toStep, type Exec, type StepKey } from './moaClient.ts';
import { describe, parseIntent, type Plan } from './intent.ts';
import { reply as offlineReply } from './moa.ts';
import type { Execution } from './store.ts';
import { CoinMark } from './CoinMark.tsx';
import { loadWeather, skyOf, type Weather } from './weather.ts';

export interface MoaContext { venue: 'cex' | 'dex'; label: string; asset: string; perp: boolean }
export type Level = 'new' | 'some' | 'pro';
interface Choice { label: string; act: () => void }
interface Note { id: number; at: number; role: 'moa' | 'you'; text: string; card?: StratNote; plan?: Plan; goal?: string; execs?: Exec[]; offline?: boolean; follow: string[]; choices?: Choice[]; chosen?: string; sky?: { level: Level; list: Weather[] } }
type Line = Omit<Note, 'id' | 'at' | 'role'>;
type Topic = 'why' | 'how' | 'when' | 'split' | 'alert' | 'other' | 'strats' | 'chart' | 'rule' | 'doit' | 'self';
const PRO_WORDS = /(rsi|macd|ema|롱|숏|레버리지|펀딩|볼린저|지표|long|short|leverage|funding|bollinger)/i;
const readLevel = (): Level | null => { try { const v = localStorage.getItem('moa.level'); return v === 'new' || v === 'some' || v === 'pro' ? v : null; } catch { return null; } };
const saveLevel = (l: Level) => { try { localStorage.setItem('moa.level', l); } catch { /* storage unavailable */ } };
/** Typing time grows with the length of the line, like a person writing it. */
const beat = (text: string) => Math.min(1400, 420 + text.length * 16);
const time = (t: number, lang: string) => new Date(t).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
const MOVE = 0.005;         // a 0.5 percentage-point change in the gap triggers a new note
const QUIET_MS = 120_000;   // at most one unprompted note every 2 minutes

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export default function MoaFeed({ quotes, vault, inject, context, onCreate, onExecuted }: {
  quotes: Quote[]; vault: VaultInfo | null; inject?: StratNote | null; context: MoaContext;
  onCreate: (goal: string, plan: Plan) => void; onExecuted: (x: Execution[]) => void;
}) {
  const { t, lang } = useT();
  const [notes, setNotes] = useState<Note[]>([]);
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState<StepKey[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  const notesRef = useRef<Note[]>([]); notesRef.current = notes;
  const lastGap = useRef<Partial<Record<Quote['asset'], number>>>({});
  const lastNoteAt = useRef(0);
  const nextId = useRef(1);
  const [level, setLevelState] = useState<Level | null>(readLevel);
  const levelRef = useRef<Level | null>(level); levelRef.current = level;
  const sky = useRef<Weather[] | null>(null);
  const scriptRun = useRef(0);
  const greeted = useRef(false);
  const lastCtx = useRef(context.label);
  const quotesRef = useRef(quotes); quotesRef.current = quotes;

  const push = (n: Omit<Note, 'id' | 'at'>) => setNotes((cur) => [...cur, { ...n, id: nextId.current++, at: Date.now() }]);
  /** Moa's own short notes: a brief "typing" beat, then the note. */
  const say = (n: Line, delay = 600) => {
    setTyping(true);
    setTimeout(() => { setTyping(false); push({ ...n, role: 'moa' }); lastNoteAt.current = Date.now(); }, delay);
  };
  /** Several lines in a row, each after its own typing beat. Anything the user does cancels the rest. */
  const script = (lines: Line[]) => {
    const run = ++scriptRun.current;
    let at = 0;
    lines.forEach((l, i) => {
      at += i === 0 ? 350 : beat(l.text);
      setTimeout(() => { if (scriptRun.current === run) setTyping(true); }, at - Math.min(700, beat(l.text) - 150));
      setTimeout(() => {
        if (scriptRun.current !== run) return;
        setTyping(i < lines.length - 1);
        push({ ...l, role: 'moa' });
        lastNoteAt.current = Date.now();
      }, at);
    });
  };
  const interrupt = () => { scriptRun.current++; setTyping(false); };
  const choose = (id: number, c: Choice) => {
    setNotes((cur) => cur.map((n) => (n.id === id ? { ...n, chosen: c.label } : n)));
    push({ role: 'you', text: c.label, follow: [] });
    c.act();
  };
  const setLevel = (l: Level) => { setLevelState(l); saveLevel(l); };

  const name = (b: 'BTC' | 'ETH') => (b === 'BTC' ? t.coinBtc : t.coinEth);
  const p1 = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const gapLine = (w: Weather) => (w.gap === undefined ? '' : w.gap >= 0.003 ? t.gapPricey((w.gap * 100).toFixed(1)) : w.gap <= -0.003 ? t.gapCheap((-w.gap * 100).toFixed(1)) : t.gapSame);
  /** Today's weather with the latest HSKSwap vs Gate gap folded in (pool prices can arrive after the candles). */
  const skies = (): Weather[] => (sky.current ?? []).map((w) => {
    const gap = quotesRef.current.find((q) => q.asset === w.base)?.gap ?? w.gap;
    const next = { ...w, gap };
    return { ...next, sky: skyOf(next) };
  });

  /* ---------- conversation topics: every answer ends with the next things worth asking ---------- */
  const visited = useRef<Set<Topic>>(new Set());
  const label = (id: Topic): string => {
    const [main, other] = skies();
    switch (id) {
      case 'why': return t.chWhy(main ? t.sky[main.sky][1] : '');
      case 'other': return other ? t.chOther(name(other.base)) : t.chOther(t.coinEth);
      default: return t.topic[id];
    }
  };
  const answer = (id: Topic): { lines: Line[]; next: Topic[] } => {
    const [main, other] = skies();
    const l = levelRef.current ?? 'some';
    const go = (sel: string) => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    switch (id) {
      case 'why': return main ? { lines: [{ text: t.whyNew(name(main.base), main.m1 * 100, main.vsMa, gapLine(main)), follow: [] }], next: ['when', 'how', 'alert'] } : { lines: [{ text: t.wxNoData, follow: [] }], next: ['self'] };
      case 'how': return { lines: [{ text: l === 'pro' ? t.howSkyPro : t.howSky, follow: [] }], next: l === 'pro' ? ['rule', 'chart', 'strats'] : ['why', 'when', 'alert'] };
      case 'when': return { lines: [{ text: main && (main.sky === 'rain' || main.sky === 'storm') ? t.whenWait : t.whenNow, follow: [] }], next: ['split', 'alert', 'strats'] };
      case 'split': return { lines: [{ text: t.splitExplain, follow: [] }], next: ['when', 'alert', 'strats'] };
      case 'alert': return { lines: [{ text: t.alertOn, follow: [] }, { text: t.alertMore, follow: [] }], next: ['other', 'strats', 'self'] };
      case 'other': return other ? { lines: [{ text: l === 'new' ? `${t.wxIs(name(other.base), t.sky[other.sky][1])} ${t.skyMean[other.sky]}` : `${t.someLine(name(other.base), p1(other.m1), gapLine(other))} ${t.verdict[other.sky]}`, follow: [] }], next: ['when', 'alert', 'strats'] } : { lines: [{ text: t.wxNoData, follow: [] }], next: ['self'] };
      case 'strats': go('.strats'); return { lines: [{ text: t.stratsHere, follow: [] }], next: l === 'pro' ? ['chart', 'rule', 'self'] : ['split', 'alert', 'self'] };
      case 'chart': go('.chart-card'); return { lines: [{ text: t.chartHere, follow: [] }], next: ['strats', 'rule', 'other'] };
      case 'rule': return { lines: [{ text: t.ruleNow, follow: [] }], next: ['chart', 'strats', 'self'] };
      case 'doit': return { lines: [{ text: vault?.configured ? t.doItVault : t.doItNoVault, follow: [] }], next: ['alert', 'strats', 'self'] };
      default: setTimeout(() => input.current?.focus(), 400); return { lines: [{ text: t.selfAsk, follow: [] }], next: [] };
    }
  };
  /** Next choices: what the topic suggests, minus what was already covered, never a dead end. */
  const choicesFor = (ids: Topic[]): Choice[] => {
    const fresh = ids.filter((x) => !visited.current.has(x));
    const pool = fresh.length >= 2 ? fresh : [...fresh, ...((levelRef.current === 'pro' ? ['other', 'strats', 'chart', 'self'] : ['other', 'strats', 'when', 'self']) as Topic[]).filter((x) => !visited.current.has(x) && !fresh.includes(x))];
    const list = (pool.length ? pool : ['self' as Topic]).slice(0, 3);
    return list.map((id) => ({ label: label(id), act: () => runTopic(id) }));
  };
  const runTopic = (id: Topic) => {
    if (id !== 'self') visited.current.add(id);
    const { lines, next } = answer(id);
    if (!next.length) { script(lines); return; }
    const last = lines.length - 1;
    script(lines.map((x, i) => (i === last ? { ...x, choices: choicesFor(next) } : x)));
  };

  /* ---------- the briefing: same weather, three depths ---------- */
  const briefing = (l: Level): Line[] => {
    const ws = skies();
    if (!ws.length) return [{ text: t.wxNoData, follow: [] }];
    const [main, other] = ws;
    visited.current = new Set();
    const first: Topic[] = l === 'new' ? ['why', 'how', 'alert'] : l === 'some' ? ['alert', 'doit', 'strats'] : ['chart', 'strats', 'rule'];
    const pro = (w: Weather) => t.proLine(w.base, p1(w.vsMa), w.rsi.toFixed(0), p1(w.m1), w.basis === undefined ? '—' : `${w.basis > 0 ? '+' : ''}${(w.basis * 100).toFixed(3)}%`, w.gap === undefined ? '—' : `${w.gap > 0 ? '+' : ''}${(w.gap * 100).toFixed(2)}%`, w.volRatio.toFixed(2));
    const body: Line[] = l === 'new'
      ? [
        { text: t.wxIntroNew, follow: [], sky: { level: l, list: ws } },
        { text: `${t.wxIs(name(main.base), t.sky[main.sky][1])} ${t.skyMean[main.sky]}`, follow: [] },
        ...(other ? [{ text: t.wxIs(name(other.base), t.sky[other.sky][1]), follow: [] }] : []),
        { text: t.wxNextNew, follow: [] },
      ]
      : l === 'some'
        ? [
          { text: t.wxIntro, follow: [], sky: { level: l, list: ws } },
          { text: `${t.someLine(name(main.base), p1(main.m1), gapLine(main))} ${t.verdict[main.sky]}`, follow: [] },
          ...(other ? [{ text: `${t.someLine(name(other.base), p1(other.m1), gapLine(other))} ${t.verdict[other.sky]}`, follow: [] }] : []),
          { text: t.wxNextSome, follow: [] },
        ]
        : [
          { text: t.wxIntroPro, follow: [], sky: { level: l, list: ws } },
          { text: pro(main), follow: [] },
          ...(other ? [{ text: pro(other), follow: [] }] : []),
          { text: t.proState(main.base, main.vsMa > 0, main.rsi < 30), follow: [] },
        ];
    if (other) visited.current.add('other');
    body[body.length - 1] = { ...body[body.length - 1], choices: choicesFor(first) };
    return body;
  };
  const pickLevel = (l: Level) => { setLevel(l); script(briefing(l)); };

  // Opening: Moa speaks first. New visitors get one question to find their level; returning ones go straight on.
  useEffect(() => {
    if (greeted.current) return;
    greeted.current = true;
    const ready = loadWeather(quotes).then((w) => { sky.current = w; }).catch(() => { sky.current = []; });
    const l = levelRef.current;
    if (l) { void ready.then(() => script([{ text: t.helloAgain, follow: [] }, ...briefing(l)])); return; }
    script([
      { text: t.hello1, follow: [] },
      { text: t.hello2, follow: [] },
      { text: t.askLevel, follow: [], choices: [
        { label: t.lvNew, act: () => void ready.then(() => pickLevel('new')) },
        { label: t.lvSome, act: () => void ready.then(() => pickLevel('some')) },
        { label: t.lvPro, act: () => void ready.then(() => pickLevel('pro')) },
      ] },
    ]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching market: one short line, in the user's depth.
  useEffect(() => {
    if (lastCtx.current === context.label) return;
    lastCtx.current = context.label;
    if (!greeted.current || busy || Date.now() - lastNoteAt.current < 4000) return;
    say({ text: levelRef.current === 'pro' ? t.ctxSwitchPro(context.label) : t.ctxSwitch(context.label), follow: [] }, 500);
  }, [context.label]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Ask Moa right here: the question, live progress steps, then the answer (or the on-device fallback). */
  const ask = async (text: string, confirmed = false) => {
    const q = text.trim();
    if (!q || busy) return;
    if (!confirmed && EXECUTE_WORDS.test(q) && vault?.configured) { setConfirm(q); return; }
    interrupt();
    setDraft('');
    if (PRO_WORDS.test(q) && levelRef.current !== 'pro') setLevel('pro');
    const history = [
      // What the user is looking at goes in as context, so "this" and "here" mean something.
      { role: 'moa' as const, text: `${t.ctxNow}: ${context.label}` },
      ...notesRef.current.map((n) => ({ role: n.role, text: n.card ? `${n.card.name}: ${n.card.text}` : n.text })),
      { role: 'you' as const, text: q },
    ];
    push({ role: 'you', text: q, follow: [] });
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(['thinking']);
    try {
      const res = await askMoa(history, (s) => setBusy((b) => (b && b[b.length - 1] !== s ? [...b, s] : b)), ctrl.signal);
      const plan = res.plan?.steps.length ? { steps: res.plan.steps.map(toStep), missing: res.plan.missing } : undefined;
      if (res.executions?.length) onExecuted(res.executions.map((x) => ({ at: Date.now(), ok: x.ok, asset: x.request.asset, side: x.request.side, amount: x.request.amount, reason: x.reason, txHash: x.txHash, explorerUrl: x.explorerUrl, amountIn: x.amountIn, amountOut: x.amountOut, tokenIn: x.tokenIn, tokenOut: x.tokenOut })));
      push({ role: 'moa', text: res.reply, plan, goal: q, execs: res.executions?.length ? res.executions : undefined, follow: [] });
    } catch {
      if (ctrl.signal.aborted) { setBusy(null); return; }
      // No server or the AI is unreachable: answer with the on-device parser, clearly marked.
      const p = parseIntent(q);
      push({ role: 'moa', text: offlineReply(p, quotes, lang), plan: p.steps.length ? p : undefined, goal: q, offline: true, follow: [] });
    }
    setBusy(null);
    lastNoteAt.current = Date.now();
  };
  const stop = () => { abort.current?.abort(); setBusy(null); };

  // Watching: when a pool moves noticeably against Gate, Moa speaks up on its own.
  useEffect(() => {
    for (const q of quotes) {
      if (q.gap === undefined) continue;
      const prev = lastGap.current[q.asset];
      lastGap.current[q.asset] = q.gap;
      if (busy || prev === undefined || Math.abs(q.gap - prev) < MOVE || Date.now() - lastNoteAt.current < QUIET_MS) continue;
      say({ text: t.feedMoved(q.asset, (prev * 100).toFixed(1), (q.gap * 100).toFixed(1)), follow: [t.fuPlan(q.asset)] });
      break;
    }
  }, [quotes]); // eslint-disable-line react-hooks/exhaustive-deps

  // A strategy tapped under the chart arrives as a full card.
  useEffect(() => { if (inject) say({ text: inject.text, card: inject, follow: [] }, 380); }, [inject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = feed.current; if (el && (notes.length || busy)) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [notes, typing, busy]);
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; }, [draft]);
  useEffect(() => {
    if (!busy) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="dock feed-dock" aria-label="Moa">
      <header className="feed-head">
        <span className="orb sm breathe" aria-hidden />
        <b>Moa</b>
        <span className="feed-status"><span className="live-dot" /> {level ? t.live : t.feedWatching}</span>
        {level && (
          <div className="depth-switch has-pill" role="tablist" aria-label={t.depthLabel}>
            <SlidePill dep={level} />
            {(['new', 'some', 'pro'] as Level[]).map((l) => <button key={l} role="tab" aria-selected={level === l} className={level === l ? 'on' : ''} onClick={() => { if (l !== level && !busy) { interrupt(); setLevel(l); script([{ text: t.depthNow[l], follow: [] }, ...briefing(l)]); } }}>{t.depth[l]}</button>)}
          </div>
        )}
        {notes.length > 0 && !busy && <button className="feed-clear" onClick={() => setNotes([])} data-tip={t.feedClearTip} aria-label={t.feedClearTip}><Icon d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" /></button>}
      </header>

      <div className="feed" ref={feed} aria-live="polite">
        {notes.map((n, k) => n.role === 'you' ? (
          <div key={n.id} className="you-row fade-up"><p className="you-bubble">{n.text}</p></div>
        ) : (
          <article key={n.id} className="note fade-up">
            {/* Messenger grouping: name and time only on the first of consecutive Moa lines. */}
            {(k === 0 || notes[k - 1].role !== 'moa' || n.at - notes[k - 1].at > 60_000) && <div className="note-meta"><span className="orb xs" aria-hidden /> Moa <time>{time(n.at, lang)}</time></div>}
            {n.card ? <StratCard c={n.card} onAsk={(p) => void ask(p)} /> : <div className="note-text"><RichText text={n.text} /></div>}
            {n.sky && <SkyCard level={n.sky.level} list={n.sky.list} />}
            {n.choices && (
              <div className={`choices${n.chosen ? ' done' : ''}`}>
                {n.choices.map((c) => (
                  <button key={c.label} className={`choice${n.chosen === c.label ? ' picked' : ''}`} disabled={!!n.chosen || !!busy} onClick={() => choose(n.id, c)}>{c.label}</button>
                ))}
              </div>
            )}
            {n.execs?.map((x, k) => <Receipt key={k} x={x} />)}
            {n.plan && n.plan.steps.length > 0 && (
              <div className="plan-mini">
                <b>{t.planMini}</b>
                <ol>{n.plan.steps.map((s, k) => <li key={k}>{describe(s, lang)}</li>)}</ol>
                {n.plan.missing.length === 0
                  ? <button className="btn-primary" onClick={() => onCreate(n.goal ?? '', n.plan!)}>{t.makeBot}</button>
                  : <p className="muted small">{t.planNeeds(n.plan.missing.join(', '))}</p>}
              </div>
            )}
            {n.goal && <div className="note-actions"><CopyButton text={n.text} label={t.copy} done={t.copied} /></div>}
            {n.follow.length > 0 && (
              <div className="followups">
                {n.follow.map((f) => <button key={f} className="fu" disabled={!!busy} onClick={() => void ask(f)}><span aria-hidden>↳</span>{f}</button>)}
              </div>
            )}
          </article>
        ))}
        {(typing || busy) && (
          <div className="note typing-note" role="status">
            <div className="note-meta"><span className="orb xs" aria-hidden /> Moa</div>
            {busy
              ? <div className="moa-steps">{busy.map((s, k) => <span key={s} className={k === busy.length - 1 ? 'now' : 'done'}>{k === busy.length - 1 ? <span className="dots"><i /><i /><i /></span> : '✓'} {t.steps[s]}</span>)}</div>
              : <span className="dots" aria-label={t.feedTyping}><i /><i /><i /></span>}
          </div>
        )}
      </div>

      <form className="feed-composer" onSubmit={(e) => { e.preventDefault(); void ask(draft); }}>
        <span className="ctx-chip" data-tip={t.ctxTip}><CoinMark base={context.asset} />{context.label}</span>
        <div className="composer-row">
          <textarea ref={input} rows={1} value={draft} onChange={(e) => { if (!draft) interrupt(); setDraft(e.target.value); }} placeholder={t.feedPlaceholder} aria-label={t.askMoa}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft); } }} />
          {busy
            ? <button className="send-btn stop" type="button" onClick={stop} aria-label={t.stop} data-tip={`${t.stop} (Esc)`}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" /></svg></button>
            : <button className="send-btn" type="submit" disabled={!draft.trim()} aria-label={t.ask} data-tip={`${t.ask} (Enter)`}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>}
        </div>
      </form>
      <div className="feed-foot">
        <span aria-hidden>🔒</span>
        {vault?.configured
          ? <>{t.feedLimits(vault.maxTradeUsdt ?? '?', vault.maxDailyUsdt ?? '?')} {vault.vault && <CopyAddress value={vault.vault} label={t.copyAddress} done={t.addressCopied} />}{vault.localFork && <span className="fork-badge">{t.localFork}</span>}</>
          : t.trust3none}
      </div>

      {confirm && (
        <Modal title={t.confirmTitle} onClose={() => setConfirm(null)} actions={<>
          <button className="btn-ghost" onClick={() => setConfirm(null)}>{t.cancel}</button>
          <button className="btn-primary" onClick={() => { const q = confirm; setConfirm(null); void ask(q, true); }}>{t.executeBtn}</button>
        </>}>
          <p className="modal-quote">“{confirm}”</p>
          <p>{t.confirmBody(vault?.maxTradeUsdt ?? '?', vault?.remainingTodayUsdt ?? '0')}</p>
        </Modal>
      )}
    </aside>
  );
}

/** A trade Moa sent to the vault: what happened, with the explorer link. */
function Receipt({ x }: { x: Exec }) {
  const { t } = useT();
  return (
    <div className={`receipt-mini ${x.ok ? 'ok' : 'fail'}`}>
      <b>{x.ok ? t.receiptOk : t.receiptFail}</b>
      <span>{x.request.side === 'buy' ? t.buy : t.sell} {x.request.asset} · ${x.request.amount}{x.reason ? ` · ${x.reason}` : ''}</span>
      {x.explorerUrl && <a href={x.explorerUrl} target="_blank" rel="noreferrer">{t.viewTx} ↗</a>}
    </div>
  );
}

/** Price over the backtest window with the rule's reference line or level and its entries. */
function Spark({ s }: { s: NonNullable<StratNote['spark']> }) {
  const W = 320, H = 110, P = 6;
  const all = [...s.closes, ...(s.ref ?? []).filter(Number.isFinite), ...(s.level !== undefined ? [s.level] : [])];
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const x = (i: number) => P + (i / (s.closes.length - 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (v - lo) / span) * (H - 2 * P);
  const path = (xs: number[]) => xs.map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(xs[i - 1]) ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}` : '')).join('');
  const area = `${path(s.closes)}L${x(s.closes.length - 1)},${H}L${x(0)},${H}Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="price chart">
      <defs><linearGradient id="spk" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#7c5cf0" stopOpacity=".18" /><stop offset="1" stopColor="#7c5cf0" stopOpacity="0" /></linearGradient></defs>
      <path className="area-in" d={area} fill="url(#spk)" />
      {s.ref && <path d={path(s.ref)} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
      {s.level !== undefined && <line x1={P} x2={W - P} y1={y(s.level)} y2={y(s.level)} stroke="#dc2626" strokeWidth="1.2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
      <path className="draw" pathLength={1} d={path(s.closes)} fill="none" stroke="#7c5cf0" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {(s.dots ?? []).map((i) => <circle key={i} cx={x(i)} cy={y(s.closes[i])} r="3.2" fill="#16a34a" stroke="#fff" strokeWidth="1.2" />)}
    </svg>
  );
}

/** A strategy tapped under the chart, laid out as a detail card: verdict, number, chart, facts, rules, actions. */
function StratCard({ c, onAsk }: { c: StratNote; onAsk: (prompt: string, context?: string) => void }) {
  const { t } = useT();
  return (
    <div className="scard">
      <div className="scard-head">
        <div>
          <h4>{c.name}</h4>
          <span className="scard-src">{c.venue === 'cex' ? 'CEX' : 'DEX'} · {c.source}</span>
        </div>
        <span className={`sig sig-${c.signal}`}>{t.sig[c.signal]}</span>
      </div>
      <div className="scard-num">
        <RollNum flash={false} className={`scard-val ${c.good ? 'pos' : c.bad ? 'neg' : ''}`} text={c.value} />
        <span>{c.valueLabel}</span>
      </div>
      {c.spark && (
        <figure className="scard-chart">
          <Spark s={c.spark} />
          <figcaption>
            <span><i className="k-price" />{t.cardPrice}</span>
            {c.spark.refLabel && <span><i className="k-ref" />{c.spark.refLabel}</span>}
            {c.spark.levelLabel && <span><i className="k-level" />{c.spark.levelLabel}</span>}
            {!!c.spark.dots?.length && <span><i className="k-dot" />{t.cardEntries}</span>}
          </figcaption>
        </figure>
      )}
      {c.facts.length > 0 && (
        <dl className="scard-facts">
          {c.facts.map(([k, v, hint]) => <div key={k}><dt>{k}</dt><dd>{v}</dd>{hint && <small>{hint}</small>}</div>)}
        </dl>
      )}
      <p className="scard-text">{c.text}</p>
      <div className="scard-rules">
        <b>{t.cardRules}</b>
        <ul>{c.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      </div>
      <div className="scard-cta">
        <button className="btn-primary" onClick={() => onAsk(c.follow[0], c.text)}>{t.cardPlan}</button>
        <button className="btn-ghost" onClick={() => onAsk(c.follow[1], c.text)}>{t.cardRisk}</button>
      </div>
    </div>
  );
}

/** The weather card in Moa's briefing: one row per coin, worded for the user's depth. */
function SkyCard({ level, list }: { level: Level; list: Weather[] }) {
  const { t } = useT();
  return (
    <div className={`sky-card sky-${level}`}>
      {level === 'pro' && <div className="sky-title">{t.skyProTitle}</div>}
      {list.map((w) => (
        <div key={w.base} className="sky-row">
          <CoinMark base={w.base} />
          <span className="sky-name">{level === 'pro' ? w.base : w.base === 'BTC' ? t.coinBtc : t.coinEth}</span>
          <span className={`sky-icon sky-${w.sky}`} aria-hidden>{t.sky[w.sky][0]}</span>
          <span className="sky-word">{level === 'pro' ? t.skyPro[w.sky] : t.sky[w.sky][2]}</span>
          {level !== 'new' && <span className={`sky-m1 ${w.m1 >= 0 ? 'pos' : 'neg'}`}>{w.m1 > 0 ? '+' : ''}{(w.m1 * 100).toFixed(1)}%</span>}
        </div>
      ))}
    </div>
  );
}
