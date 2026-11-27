// "My agents" under the chart: every agent the user hired, the budget each was given, what it holds now and
// what it has made or lost. The same place an exchange shows positions, so the answer to "how are mine doing"
// is on the trade screen itself.
import { useT } from './i18n.ts';
import type { Quote } from './market.ts';
import type { VaultInfo } from './parts.tsx';
import { Icon } from './Icons.tsx';
import { Face, pct } from './AgentCard.tsx';
import { book, pnl, statusOf, type HiredAgent } from './runner.ts';
import { hiredName, money, qtyText, signedMoney, statusText } from './hiredText.ts';

const cls = (v: number | undefined) => (v === undefined ? '' : v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : '');

export default function MineDock({ hired, quotes, vault, now, sending, onOpen, onEdit, onPause, onResume }: {
  hired: HiredAgent[]; quotes: Quote[]; vault: VaultInfo | null; now: number; sending: Set<string>;
  onOpen: (id: string) => void; onEdit: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void;
}) {
  const { t } = useT();
  const rows = hired.map((h) => {
    const b = book(h);
    const price = quotes.find((q) => q.asset === h.asset)?.pool;
    return { h, b, st: statusOf(h, now), value: b.qty > 0 && price !== undefined ? b.qty * price : undefined, gain: pnl(h, price) };
  });
  const sum = rows.reduce((s, r) => ({
    spent: s.spent + r.b.spent, budget: s.budget + r.h.budgetUsd, value: s.value + (r.value ?? 0),
    gain: s.gain + (r.gain ?? 0), left: s.left + (r.h.paused ? 0 : Math.max(0, r.h.budgetUsd - r.b.spent)),
  }), { spent: 0, budget: 0, value: 0, gain: 0, left: 0 });
  const traded = rows.some((r) => r.gain !== undefined);
  // What the agents may still spend against what the vault holds: a budget is a promise only if the USDT is there.
  const usdt = vault?.configured ? Number(vault.usdtBalance ?? 0) : undefined;
  const short = usdt !== undefined && sum.left > usdt + 0.005;

  return (
    <div className="md" role="table" aria-label={t.navMine}>
      <div className="md-head" role="row">
        <span role="columnheader">{t.thName}</span><span role="columnheader">{t.thState}</span><span role="columnheader">{t.thBudget}</span>
        <span role="columnheader">{t.scValue}</span><span role="columnheader">{t.thPnl}</span><span />
      </div>
      {rows.map(({ h, b, st, value, gain }) => {
        const busy = !!h.pending && sending.has(h.pending.id);
        const used = h.budgetUsd > 0 ? Math.min(1, b.spent / h.budgetUsd) : 0;
        return (
          <div key={h.id} className={`md-row st-${st}`} role="row">
            <span role="cell" className="md-who">
              {h.source.type === 'market' ? <Face rule={h.source.rule} size="sm" /> : <span className="face sm" aria-hidden><Icon name="chat" size={16} /></span>}
              <span className="md-main">
                <button className="md-name" onClick={() => onOpen(h.id)}>{hiredName(t, h)}{h.mode === 'auto' && <span className="auto-tag">{t.autoBadge}</span>}</button>
                <small>{h.asset} · {t.mdPer(money(h.perBuyUsd))}</small>
              </span>
            </span>
            <span role="cell" className="md-state"><i className={`chip-dot ${st}`} aria-hidden />{busy ? t.stSending : statusText(t, h, now)}</span>
            <span role="cell" className="md-budget">
              <span>${money(b.spent)} <em>/ ${money(h.budgetUsd)}</em></span>
              <span className={`gauge${used >= 0.999 ? ' full' : ''}`} aria-hidden><i style={{ width: `${Math.round(used * 100)}%` }} /></span>
            </span>
            <span role="cell" className="md-num">
              {value !== undefined ? <><b>${money(value)}</b><small>{qtyText(b.qty)} {h.asset}</small></> : <b className="none">{t.scNone}</b>}
            </span>
            <span role="cell" className="md-num">
              {gain !== undefined ? <><b className={cls(gain)}>{signedMoney(gain)}</b><small className={cls(gain)}>{b.spent > 0 ? pct(gain / b.spent) : ''}</small></> : <b className="none">{t.scNone}</b>}
            </span>
            <span role="cell" className="md-ctl">
              {st === 'confirm'
                ? <button className="btn sm md-ask" onClick={() => onOpen(h.id)} disabled={busy}>{t.stReview}</button>
                : <>
                  <button className="icon-btn" onClick={() => onEdit(h.id)} aria-label={t.scEdit} data-tip={t.scEdit}><Icon name="edit" size={16} /></button>
                  {h.paused
                    ? <button className="icon-btn" onClick={() => onResume(h.id)} aria-label={t.stResume} data-tip={t.stResume}><Icon name="play" size={16} /></button>
                    : <button className="icon-btn" onClick={() => onPause(h.id)} disabled={st === 'done'} aria-label={t.stPause} data-tip={t.stPause}><Icon name="pause" size={16} /></button>}
                </>}
            </span>
          </div>
        );
      })}
      <div className="md-foot" role="row">
        <span role="cell"><b>{t.mdTotal(rows.length)}</b>{usdt !== undefined && <small>{t.mdVault(money(usdt))}</small>}</span>
        <span role="cell" />
        <span role="cell" className="md-budget"><span>${money(sum.spent)} <em>/ ${money(sum.budget)}</em></span></span>
        <span role="cell" className="md-num"><b>{sum.value > 0 ? `$${money(sum.value)}` : t.scNone}</b></span>
        <span role="cell" className="md-num"><b className={traded ? cls(sum.gain) : 'none'}>{traded ? signedMoney(sum.gain) : t.scNone}</b></span>
        <span role="cell" />
      </div>
      {short && <p className="md-warn"><Icon name="shield" size={14} />{t.mdShort(money(sum.left), money(usdt!))}</p>}
    </div>
  );
}
