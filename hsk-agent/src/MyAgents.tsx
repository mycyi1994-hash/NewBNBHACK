// My agents: where hired agents live. Settings, money, records, and the controls that matter
// (change amount, pause, remove). Nothing here recommends or explains; that is Moa's job.
import { useState } from 'react';
import { useT } from './i18n.ts';
import type { Quote } from './market.ts';
import type { VaultInfo } from './parts.tsx';
import type { Execution } from './store.ts';
import { Modal, useToast } from './ui.tsx';
import { RuleIcon } from './AgentCard.tsx';
import { book, statusOf, type HiredAgent } from './runner.ts';
import { eventLine, hiredName, money, moneyLine, qtyText, statusText } from './hiredText.ts';

const loc = () => (document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR');
const when = (t: number) => new Date(t).toLocaleString(loc(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function HiredCard({ h, price, now, onEdit, onPause, onResume, onRemove, onOpen }: {
  h: HiredAgent; price?: number; now: number;
  onEdit: () => void; onPause: () => void; onResume: () => void; onRemove: () => void; onOpen: () => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const st = statusOf(h, now);
  const b = book(h);
  const m = moneyLine(t, h, price);
  const log = [...h.log].reverse();
  return (
    <article className={`mine-card st-${st}`}>
      <header className="mine-head">
        <span className={`ag-avatar ${h.source.type === 'market' ? `ag-r-${h.source.rule}` : 'ag-r-custom'}`} aria-hidden>
          {h.source.type === 'market' ? <RuleIcon rule={h.source.rule} /> : <span className="orb xs" />}
        </span>
        <div className="mine-title">
          <b>{hiredName(t, h)}</b>
          <span className="muted">{h.source.type === 'market' ? t.mineFromMarket : `${t.mineCustom} · “${h.source.goal}”`}</span>
        </div>
        <span className={`chip-dot ${st}`} aria-hidden />
        <span className="mine-st">{statusText(t, h, now)}</span>
      </header>
      <dl className="kv mine-kv">
        <dt>{t.scPer}</dt><dd>${money(h.perBuyUsd)}</dd>
        <dt>{t.scSpent}</dt><dd>${money(b.spent)} / ${money(h.budgetUsd)}</dd>
        <dt>{t.scHeld}</dt><dd>{b.qty > 0 ? `${qtyText(b.qty)} ${h.asset}` : t.scNone}</dd>
        <dt>{t.scValue}</dt><dd>{b.qty > 0 && price !== undefined ? `$${money(b.qty * price)}` : t.scNone}</dd>
        <dt>{t.scPnl}</dt><dd className={m.cls}>{h.fills.length ? m.text : t.scNone}</dd>
      </dl>
      <div className="mine-actions">
        <button className="btn-ghost" onClick={onEdit}>{t.scEdit}</button>
        {h.paused ? <button className="btn-ghost" onClick={onResume}>{t.stResume}</button> : <button className="btn-ghost" onClick={onPause} disabled={st === 'done'}>{t.stPause}</button>}
        <button className="btn-ghost" onClick={onOpen}>{t.acAsk}</button>
        <button className="btn-ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{t.mineLog} ({h.log.length})</button>
        <button className="btn-ghost danger" onClick={onRemove}>{t.mineRemove}</button>
      </div>
      {open && (
        <ol className="mine-log">
          {!log.length && <li className="muted">{t.mineNoLog}</li>}
          {log.slice(0, 40).map((e, i) => {
            const x = eventLine(t, h, e);
            return (
              <li key={i}>
                <time>{when(e.at)}</time>
                <b>{x.label}</b>
                {x.detail && <span className="muted">{x.detail}</span>}
                {x.link && <a href={x.link} target="_blank" rel="noreferrer">{t.viewTx} ↗</a>}
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}

export default function MyAgents({ hired, quotes, vault, execs, now, onEdit, onPause, onResume, onRemove, onOpen, onRecommend }: {
  hired: HiredAgent[]; quotes: Quote[]; vault: VaultInfo | null; execs: Execution[]; now: number;
  onEdit: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void; onRemove: (id: string) => void;
  onOpen: (id: string) => void; onRecommend: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [removing, setRemoving] = useState<HiredAgent | null>(null);
  return (
    <div className="page mine-page">
      {removing && (
        <Modal title={t.mineRemoveTitle} onClose={() => setRemoving(null)} actions={<>
          <button className="btn-ghost" onClick={() => setRemoving(null)}>{t.cancel}</button>
          <button className="btn-danger" onClick={() => { onRemove(removing.id); setRemoving(null); toast(t.botDeleted); }}>{t.mineRemove}</button>
        </>}>
          <p><b>{hiredName(t, removing)}</b> · {t.mineRemoveBody}</p>
        </Modal>
      )}
      <header className="ag-head">
        <h1>{t.mineTitle}</h1>
        <p className="muted">{t.mineSub}</p>
      </header>
      <div className="mine-grid">
        <div className="mine-list">
          {!hired.length && (
            <section className="card empty">
              <span className="orb lg breathe" aria-hidden />
              <div className="empty-title">{t.mineEmpty}</div>
              <div className="muted">{t.mineEmptySub}</div>
              <button className="btn-primary" onClick={onRecommend}>{t.barRecommend}</button>
            </section>
          )}
          {hired.map((h) => (
            <HiredCard key={h.id} h={h} now={now} price={quotes.find((q) => q.asset === h.asset)?.pool}
              onEdit={() => onEdit(h.id)} onPause={() => onPause(h.id)} onResume={() => onResume(h.id)} onRemove={() => setRemoving(h)} onOpen={() => onOpen(h.id)} />
          ))}
          {execs.length > 0 && (
            <section className="card">
              <div className="panel-label">{t.mineManual}</div>
              {execs.slice(0, 20).map((x, i) => (
                <div key={i} className="act-row">
                  <span className={`dot ${x.ok ? 'ok' : 'bad'}`} />
                  <span>{x.side === 'buy' ? t.buy : t.sell} {x.asset}</span>
                  <span className="muted">{x.ok ? `${x.amountIn} ${x.tokenIn} → ${Number(x.amountOut).toPrecision(6)} ${x.tokenOut}` : x.reason}</span>
                  <span className="muted">{when(x.at)}</span>
                  {x.explorerUrl ? <a href={x.explorerUrl} target="_blank" rel="noreferrer">{short(x.txHash)} ↗</a> : <span />}
                </div>
              ))}
            </section>
          )}
        </div>
        <aside className="mine-side">
          <section className="card">
            <div className="panel-label">{t.limits}</div>
            {vault?.configured ? (
              <dl className="kv">
                <dt>{t.perTrade}</dt><dd>${vault.maxTradeUsdt}</dd>
                <dt>{t.perDay}</dt><dd>${vault.maxDailyUsdt}</dd>
                <dt>{t.leftToday}</dt><dd>${vault.remainingTodayUsdt}</dd>
                <dt>{t.balance}</dt><dd>{Number(vault.usdtBalance).toFixed(2)}</dd>
              </dl>
            ) : <p className="muted small-text"><span className="mine-demo">{t.mineDemo}</span> {t.noVault}</p>}
            <p className="muted small">{t.mineStopNote}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
