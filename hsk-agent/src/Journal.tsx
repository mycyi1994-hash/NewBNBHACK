// "Why this decision": the inputs an order was decided on (journal.ts), shown under the order and in the agent's
// record. "Check" recomputes the keccak256 hash from these inputs in the browser and compares it with the hash that
// went into the trade's on-chain note.
import { useState } from 'react';
import { useT } from './i18n.ts';
import { verifyJournal, type Journal } from './journal.ts';
import type { HiredAgent, LogEvent } from './runner.ts';

const num = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : Math.abs(v) >= 1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toPrecision(4));

export function JournalBox({ j, link }: { j: Journal; link?: string }) {
  const { t, lang } = useT();
  const [checked, setChecked] = useState<boolean | null>(null);
  const d = j.entry.decision;
  const when = new Date(d.candle * 1000).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-GB', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: d.interval === '1d' ? undefined : '2-digit', minute: d.interval === '1d' ? undefined : '2-digit' });
  return (
    <details className="jr">
      <summary>{t.jrTitle}</summary>
      <dl className="jr-list">
        <div><dt>{t.jrRule}</dt><dd>{d.rule} · {d.market} · {d.interval}</dd></div>
        <div><dt>{t.jrCandle}</dt><dd>{when} UTC · {t.jrClose} {num(d.close)}</dd></div>
        {Object.entries(d.values).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{num(v)}</dd></div>)}
        <div><dt>{t.jrOut}</dt><dd>{d.out.target !== undefined ? t.jrTarget(Math.round(d.out.target * 100), Math.round((d.out.band ?? 0) * 100)) : d.out.live ? t.jrIn : t.jrOutNow}</dd></div>
        <div><dt>{t.jrOrder}</dt><dd>{j.entry.order.why}{j.entry.order.usd !== undefined ? ` · $${j.entry.order.usd}` : ''}{j.entry.order.qty !== undefined ? ` · ${num(j.entry.order.qty)}` : ''}{j.entry.held.price !== undefined ? ` · @${num(j.entry.held.price)}` : ''}</dd></div>
        <div><dt>keccak256</dt><dd className="jr-hash">{j.hash}</dd></div>
      </dl>
      <div className="jr-foot">
        <button type="button" className="btn sm" onClick={() => setChecked(verifyJournal(j))}>{t.jrCheck}</button>
        {checked !== null && <span className={checked ? 'jr-ok' : 'jr-bad'}>{checked ? t.jrOk : t.jrBad}</span>}
        {link && <a href={link} target="_blank" rel="noreferrer">{t.jrOnChain} ↗</a>}
      </div>
    </details>
  );
}

/** The journal of the order a log event is about: the asked order itself, or for its outcome the order it answered. */
export function journalOf(h: HiredAgent, e: LogEvent): Journal | undefined {
  if (e.k === 'asked') return e.order.journal;
  if (e.k !== 'filled' && e.k !== 'failed') return undefined;
  for (const y of h.log) if (y.k === 'asked' && y.order.id === e.orderId) return y.order.journal;
  return undefined;
}
