// Moa on the right of the trade screen, Grok-style: Moa speaks first, answers sit as plain text (no bubble),
// each note ends with "↳" follow-ups you can tap. Every number comes from live data (pool vs Gate, vault),
// never from the model, so Moa can open the conversation instantly and honestly.
import { useEffect, useRef, useState } from 'react';
import type { Quote } from './market.ts';
import { useT } from './i18n.ts';
import { MoaSees, type VaultInfo } from './parts.tsx';
import { CopyAddress, CopyButton } from './ui.tsx';
import type { StratNote } from './Strategies.tsx';

interface Note { id: number; at: number; text: string; sees?: boolean; card?: StratNote; follow: string[] }
const time = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const pct = (g: number) => Math.abs(g * 100).toFixed(1);
const NOTABLE = 0.003;      // a pool more than 0.3% away from Gate is worth mentioning
const MOVE = 0.005;         // a 0.5 percentage-point change in the gap triggers a new note
const QUIET_MS = 120_000;   // at most one unprompted note every 2 minutes

export default function MoaFeed({ quotes, vault, onAsk, inject }: { quotes: Quote[]; vault: VaultInfo | null; onAsk: (prompt: string, context?: string) => void; inject?: StratNote | null }) {
  const { t, lang } = useT();
  const [notes, setNotes] = useState<Note[]>([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastGap = useRef<Partial<Record<Quote['asset'], number>>>({});
  const lastNoteAt = useRef(0);
  const greeted = useRef(false);
  const nextId = useRef(1);

  /** Show "Moa is typing…" briefly, then the note (Grok / messenger feel). */
  const say = (n: Omit<Note, 'id' | 'at'>, delay = 700) => {
    setTyping(true);
    setTimeout(() => {
      setTyping(false);
      setNotes((cur) => [...cur, { ...n, id: nextId.current++, at: Date.now() }]);
      lastNoteAt.current = Date.now();
    }, delay);
  };

  // Opening: once prices are in, Moa says what it sees, then what the vault allows.
  useEffect(() => {
    const live = quotes.filter((q) => q.gap !== undefined);
    if (greeted.current || live.length === 0) return;
    greeted.current = true;
    live.forEach((q) => { lastGap.current[q.asset] = q.gap; });
    const cheap = [...live].sort((a, b) => a.gap! - b.gap!)[0];
    const pricey = [...live].sort((a, b) => b.gap! - a.gap!)[0];
    const lines = [t.feedHello];
    if (cheap.gap! < -NOTABLE) lines.push(t.feedCheap(cheap.asset, pct(cheap.gap!)));
    if (pricey.gap! > NOTABLE) lines.push(t.feedPricey(pricey.asset, pct(pricey.gap!)));
    if (lines.length === 1) lines.push(t.feedFlat);
    const focus = cheap.gap! < -NOTABLE ? cheap.asset : 'HSK';
    say({ text: lines.join(' '), sees: true, follow: [t.fuPlan(focus), t.fuGuard, t.fuWhy] }, 500);
    setTimeout(() => {
      if (vault?.configured) say({ text: t.feedVault(Number(vault.usdtBalance).toFixed(0), vault.remainingTodayUsdt ?? '0', vault.maxTradeUsdt ?? '?'), follow: [t.fuBudget] });
      else say({ text: t.feedNoVault, follow: [t.fuHowVault] });
    }, 1600);
  }, [quotes, vault]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watching: when a pool moves noticeably against Gate, Moa speaks up on its own.
  useEffect(() => {
    if (!greeted.current) return;
    for (const q of quotes) {
      if (q.gap === undefined) continue;
      const prev = lastGap.current[q.asset];
      lastGap.current[q.asset] = q.gap;
      if (prev === undefined || Math.abs(q.gap - prev) < MOVE || Date.now() - lastNoteAt.current < QUIET_MS) continue;
      say({ text: t.feedMoved(q.asset, (prev * 100).toFixed(1), (q.gap * 100).toFixed(1)), follow: [t.fuPlan(q.asset)] });
      break;
    }
  }, [quotes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-greet in the other language when the user switches it.
  useEffect(() => { if (greeted.current) { greeted.current = false; setNotes([]); } }, [lang]);

  // A strategy tapped under the chart: Moa explains it here.
  useEffect(() => { if (inject) say({ text: inject.text, card: inject, follow: [] }, 450); }, [inject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = feed.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [notes, typing]);
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; }, [draft]);

  const lastText = notes[notes.length - 1]?.text;
  const submit = () => { const v = draft.trim(); if (v) { onAsk(v, lastText); setDraft(''); } };

  return (
    <aside className="dock feed-dock" aria-label="Moa">
      <header className="feed-head">
        <span className="orb sm breathe" aria-hidden />
        <b>Moa</b>
        <span className="feed-status"><span className="live-dot" /> {t.feedWatching}</span>
      </header>

      <div className="feed" ref={feed} aria-live="polite">
        {notes.map((n) => (
          <article key={n.id} className="note fade-up">
            <div className="note-meta"><span className="orb xs" aria-hidden /> Moa <time>{time(n.at)}</time></div>
            {n.card ? <StratCard c={n.card} onAsk={onAsk} /> : <p className="note-text">{n.text}</p>}
            {n.sees && <div className="note-card"><MoaSees quotes={quotes} /></div>}
            <div className="note-actions"><CopyButton text={n.text} label={t.copy} done={t.copied} /></div>
            {n.follow.length > 0 && (
              <div className="followups">
                {n.follow.map((f) => (
                  <button key={f} className="fu" onClick={() => onAsk(f, n.text)}><span aria-hidden>↳</span>{f}</button>
                ))}
              </div>
            )}
          </article>
        ))}
        {(typing || notes.length === 0) && (
          <div className="note typing-note" role="status">
            <div className="note-meta"><span className="orb xs" aria-hidden /> Moa</div>
            <span className="dots" aria-label={t.feedTyping}><i /><i /><i /></span>
          </div>
        )}
      </div>

      <form className="feed-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <textarea ref={input} rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.feedPlaceholder} aria-label={t.askMoa}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <button className="send-btn" type="submit" disabled={!draft.trim()} aria-label={t.ask} data-tip={`${t.ask} (Enter)`}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
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
      <path d={area} fill="url(#spk)" />
      {s.ref && <path d={path(s.ref)} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
      {s.level !== undefined && <line x1={P} x2={W - P} y1={y(s.level)} y2={y(s.level)} stroke="#dc2626" strokeWidth="1.2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
      <path d={path(s.closes)} fill="none" stroke="#7c5cf0" strokeWidth="2" vectorEffect="non-scaling-stroke" />
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
        <strong className={c.good ? 'pos' : ''}>{c.value}</strong>
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
