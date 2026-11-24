// Moa on the right of the trade screen.
// Opens instantly (never waits on data): a short greeting, a live market brief, and "start with" cards
// for the market you are looking at. Below that, Moa's own notes appear as the market moves, and a tapped
// strategy arrives as a full card. The composer carries a chip with the market in view, so a question is
// always about something. Every number comes from live data (pool vs Gate, vault), never from the model.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import { RollNum } from './motion.tsx';
import type { VaultInfo } from './parts.tsx';
import { CopyAddress, CopyButton } from './ui.tsx';
import type { StratNote } from './Strategies.tsx';

export interface MoaContext { venue: 'cex' | 'dex'; label: string; asset: 'HSK' | 'ETH' | 'BTC' }
interface Note { id: number; at: number; text: string; card?: StratNote; follow: string[] }
const time = (t: number, lang: string) => new Date(t).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
const MOVE = 0.005;         // a 0.5 percentage-point change in the gap triggers a new note
const QUIET_MS = 120_000;   // at most one unprompted note every 2 minutes

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const ICONS = {
  stack: 'M4 13l6 3 6-3M4 9.5l6 3 6-3M10 3l6 3-6 3-6-3 6-3z',
  tag: 'M3 10.5V4a1 1 0 011-1h6.5L17 9.5 10.5 16 3 10.5zM7 7h.01',
  shield: 'M10 3l6 2.5v4c0 3.6-2.6 6.4-6 7.5-3.4-1.1-6-3.9-6-7.5v-4L10 3z',
  chart: 'M3 16h14M5 13l3-4 3 2 4-6',
  pulse: 'M2 10h4l2-5 4 10 2-5h4',
  ask: 'M5 15l-2 2V5a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5z',
};

export default function MoaFeed({ quotes, vault, onAsk, inject, context }: {
  quotes: Quote[]; vault: VaultInfo | null; onAsk: (prompt: string, context?: string) => void; inject?: StratNote | null; context: MoaContext;
}) {
  const { t, lang } = useT();
  const [notes, setNotes] = useState<Note[]>([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastGap = useRef<Partial<Record<Quote['asset'], number>>>({});
  const lastNoteAt = useRef(0);
  const nextId = useRef(1);

  const say = (n: Omit<Note, 'id' | 'at'>, delay = 600) => {
    setTyping(true);
    setTimeout(() => {
      setTyping(false);
      setNotes((cur) => [...cur, { ...n, id: nextId.current++, at: Date.now() }]);
      lastNoteAt.current = Date.now();
    }, delay);
  };

  // Watching: when a pool moves noticeably against Gate, Moa speaks up on its own.
  useEffect(() => {
    for (const q of quotes) {
      if (q.gap === undefined) continue;
      const prev = lastGap.current[q.asset];
      lastGap.current[q.asset] = q.gap;
      if (prev === undefined || Math.abs(q.gap - prev) < MOVE || Date.now() - lastNoteAt.current < QUIET_MS) continue;
      say({ text: t.feedMoved(q.asset, (prev * 100).toFixed(1), (q.gap * 100).toFixed(1)), follow: [t.fuPlan(q.asset)] });
      break;
    }
  }, [quotes]); // eslint-disable-line react-hooks/exhaustive-deps

  // A strategy tapped under the chart arrives as a full card.
  useEffect(() => { if (inject) say({ text: inject.text, card: inject, follow: [] }, 380); }, [inject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = feed.current; if (el && notes.length) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [notes, typing]);
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; }, [draft]);

  const lastText = notes[notes.length - 1]?.text;
  const submit = () => { const v = draft.trim(); if (v) { onAsk(v, `${context.label}. ${lastText ?? ''}`.trim()); setDraft(''); } };

  const a = context.asset;
  const starts: { icon: keyof typeof ICONS; title: string; sub: string; prompt: string }[] = context.venue === 'cex'
    ? [
      { icon: 'chart', title: t.stTrend, sub: t.stTrendSub, prompt: t.pcTrend },
      { icon: 'shield', title: t.stStop, sub: t.stStopSub, prompt: t.pcAtr },
      { icon: 'pulse', title: t.stMood, sub: t.stMoodSub, prompt: t.stMoodQ },
      { icon: 'ask', title: t.stExplain, sub: t.stExplainSub, prompt: t.stExplainQ(context.label) },
    ]
    : [
      { icon: 'stack', title: t.stDaily, sub: t.stDailySub(a), prompt: t.fuPlan(a) },
      { icon: 'tag', title: t.stCheap, sub: t.stCheapSub, prompt: t.s1Prompt(a) },
      { icon: 'shield', title: t.stStop, sub: t.stStopSubDex(a), prompt: t.stStopQ(a) },
      { icon: 'ask', title: t.stWhy, sub: t.stWhySub, prompt: t.fuWhy },
    ];

  return (
    <aside className="dock feed-dock" aria-label="Moa">
      <header className="feed-head">
        <span className="orb sm breathe" aria-hidden />
        <b>Moa</b>
        <span className="feed-status"><span className="live-dot" /> {t.feedWatching}</span>
        {notes.length > 0 && <button className="feed-clear" onClick={() => setNotes([])} data-tip={t.feedClearTip} aria-label={t.feedClearTip}><Icon d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" /></button>}
      </header>

      <div className="feed" ref={feed} aria-live="polite">
        <section className="moa-hero">
          <span className="orb lg breathe" aria-hidden />
          <h2>{t.heroQ}</h2>
          <p>{t.heroSub}</p>
        </section>

        <Brief quotes={quotes} vault={vault} />

        <section className="moa-starts" aria-label={t.stTitle}>
          <div className="moa-sec-title">{t.stTitle}</div>
          <div className="start-grid stagger">
            {starts.map((s) => (
              <button key={s.title} className="start-card" onClick={() => onAsk(s.prompt, context.label)}>
                <span className="start-ic"><Icon d={ICONS[s.icon]} /></span>
                <b>{s.title}</b>
                <small>{s.sub}</small>
              </button>
            ))}
          </div>
        </section>

        {notes.map((n) => (
          <article key={n.id} className="note fade-up">
            <div className="note-meta"><span className="orb xs" aria-hidden /> Moa <time>{time(n.at, lang)}</time></div>
            {n.card ? <StratCard c={n.card} onAsk={onAsk} /> : <p className="note-text">{n.text}</p>}
            {!n.card && <div className="note-actions"><CopyButton text={n.text} label={t.copy} done={t.copied} /></div>}
            {n.follow.length > 0 && (
              <div className="followups">
                {n.follow.map((f) => <button key={f} className="fu" onClick={() => onAsk(f, n.text)}><span aria-hidden>↳</span>{f}</button>)}
              </div>
            )}
          </article>
        ))}
        {typing && (
          <div className="note typing-note" role="status">
            <div className="note-meta"><span className="orb xs" aria-hidden /> Moa</div>
            <span className="dots" aria-label={t.feedTyping}><i /><i /><i /></span>
          </div>
        )}
      </div>

      <form className="feed-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <span className="ctx-chip" data-tip={t.ctxTip}><span className={`coin coin-${context.asset.toLowerCase()}`} />{context.label}</span>
        <div className="composer-row">
          <textarea ref={input} rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.feedPlaceholder} aria-label={t.askMoa}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
          <button className="send-btn" type="submit" disabled={!draft.trim()} aria-label={t.ask} data-tip={`${t.ask} (Enter)`}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </form>
      <div className="feed-foot">
        <span aria-hidden>🔒</span>
        {vault?.configured
          ? <>{t.feedLimits(vault.maxTradeUsdt ?? '?', vault.maxDailyUsdt ?? '?')} {vault.vault && <CopyAddress value={vault.vault} label={t.copyAddress} done={t.addressCopied} />}{vault.localFork && <span className="fork-badge">{t.localFork}</span>}</>
          : t.trust3none}
      </div>
    </aside>
  );
}

/** "What Moa sees right now": HSKSwap pools vs Gate and the vault, with LIVE / loading / UNAVAILABLE states. */
function Brief({ quotes, vault }: { quotes: Quote[]; vault: VaultInfo | null }) {
  const { t } = useT();
  const live = quotes.filter((q) => q.gap !== undefined);
  const down = quotes.length > 0 && live.length === 0;
  let body: ReactNode;
  if (quotes.length === 0) body = [0, 1, 2].map((i) => <div key={i} className="brief-row" aria-hidden><span className="skel" style={{ width: 90 }} /><span className="skel" style={{ width: 54 }} /></div>);
  else body = quotes.map((q) => (
    <div key={q.asset} className="brief-row">
      <span className="brief-coin"><span className={`coin coin-${q.asset.toLowerCase()}`} />{q.asset}</span>
      <RollNum className="brief-px" text={q.pool !== undefined ? `$${fmtPrice(q.pool)}` : '—'} />
      {q.gap !== undefined
        ? <span className={`brief-gap ${q.gap <= -0.003 ? 'cheap' : q.gap >= 0.003 ? 'pricey' : ''}`}>{q.gap > 0 ? '+' : ''}{(q.gap * 100).toFixed(2)}%</span>
        : <span className="brief-gap muted">—</span>}
      <span className="brief-take">{q.gap === undefined ? t.briefNoGate : Math.abs(q.gap) < 0.003 ? t.seesInLine : q.gap > 0 ? t.seesPricey : t.seesCheap}</span>
    </div>
  ));
  return (
    <section className="moa-brief">
      <div className="moa-sec-title">
        {t.briefTitle}
        <span className={`brief-state ${down ? 'down' : quotes.length ? 'live' : ''}`}>{down ? t.briefDown : quotes.length ? t.live : t.stratLoading}</span>
      </div>
      <div className="brief-box">
        <div className="brief-cols"><span>{t.briefCoin}</span><span>HSKSwap</span><span>{t.briefVsGate}</span><span /></div>
        {body}
        <div className="brief-vault">
          {vault?.configured
            ? t.briefVault(Number(vault.usdtBalance).toFixed(0), vault.remainingTodayUsdt ?? '0')
            : t.feedNoVault}
        </div>
      </div>
    </section>
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
