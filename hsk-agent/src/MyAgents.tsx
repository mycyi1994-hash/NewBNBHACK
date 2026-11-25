// My agents: where hired agents live, laid out as a table (name and source, what it is doing now, money,
// and the controls that matter: ask Moa, change amount, pause, records, remove). Nothing here recommends
// or explains; that is Moa's job.
import { Fragment, useState } from 'react';
import { useT } from './i18n.ts';
import type { Quote } from './market.ts';
import type { VaultInfo } from './parts.tsx';
import type { Execution } from './store.ts';
import { Modal, useToast } from './ui.tsx';
import { Icon, Spark } from './Icons.tsx';
import { book, statusOf, type HiredAgent } from './runner.ts';
import { eventLine, hiredName, money, moneyLine, qtyText, statusText } from './hiredText.ts';

const loc = () => (document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR');
const when = (t: number) => new Date(t).toLocaleString(loc(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export default function MyAgents({ hired, quotes, vault, execs, now, onEdit, onPause, onResume, onRemove, onOpen, onRecommend }: {
  hired: HiredAgent[]; quotes: Quote[]; vault: VaultInfo | null; execs: Execution[]; now: number;
  onEdit: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void; onRemove: (id: string) => void;
  onOpen: (id: string) => void; onRecommend: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [removing, setRemoving] = useState<HiredAgent | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="page mine-page">
      {removing && (
        <Modal title={t.mineRemoveTitle} onClose={() => setRemoving(null)} actions={<>
          <button className="btn-text" onClick={() => setRemoving(null)}>{t.cancel}</button>
          <button className="btn danger" onClick={() => { onRemove(removing.id); setRemoving(null); toast(t.botDeleted); }}>{t.mineRemove}</button>
        </>}>
          <p><b>{hiredName(t, removing)}</b> · {t.mineRemoveBody}</p>
        </Modal>
      )}
      <header className="page-head">
        <h1>{t.mineTitle}</h1>
        <button className="btn" onClick={onRecommend}><Spark size={14} />{t.barRecommend}</button>
      </header>
      <p className="page-sub">{t.mineSub}</p>

      {hired.length > 0 && (
        <div className="tbl" role="table" aria-label={t.mineTitle}>
          <div className="tbl-head" role="row">
            <span role="columnheader">{t.thName}</span><span role="columnheader">{t.thState}</span>
            <span role="columnheader">{t.thSpent}</span><span role="columnheader">{t.thPnl}</span><span />
          </div>
          {hired.map((h) => {
            const st = statusOf(h, now);
            const b = book(h);
            const price = quotes.find((q) => q.asset === h.asset)?.pool;
            const m = moneyLine(t, h, price);
            const log = [...h.log].reverse();
            return (
              <Fragment key={h.id}>
                <div className={`tbl-row st-${st}`} role="row">
                  <span role="cell" className="tbl-main">
                    <button className="tbl-link" onClick={() => onOpen(h.id)}>{hiredName(t, h)}</button>
                    <small>{h.source.type === 'market' ? t.mineFromMarket : `${t.mineCustom} · “${h.source.goal}”`}</small>
                  </span>
                  <span role="cell" className="tbl-main">
                    <span className="state"><i className={`chip-dot ${st}`} aria-hidden />{statusText(t, h, now)}</span>
                    <small>{b.qty > 0 ? `${t.scHeld} ${qtyText(b.qty)} ${h.asset}` : `${t.scPer} $${money(h.perBuyUsd)}`}</small>
                  </span>
                  <span role="cell" className="tbl-main num">
                    <span>${money(b.spent)} / ${money(h.budgetUsd)}</span>
                    <small>{b.qty > 0 && price !== undefined ? `${t.scValue} $${money(b.qty * price)}` : `${t.scPer} $${money(h.perBuyUsd)}`}</small>
                  </span>
                  <span role="cell" className={`num ${h.fills.length ? m.cls : ''}`}>{h.fills.length ? m.text : t.scNone}</span>
                  <span role="cell" className="tbl-actions">
                    <button className="icon-btn" onClick={() => onOpen(h.id)} aria-label={t.acAsk} data-tip={t.acAsk}><Icon name="chat" size={18} /></button>
                    <button className="icon-btn" onClick={() => onEdit(h.id)} aria-label={t.scEdit} data-tip={t.scEdit}><Icon name="edit" size={18} /></button>
                    {h.paused
                      ? <button className="icon-btn" onClick={() => onResume(h.id)} aria-label={t.stResume} data-tip={t.stResume}><Icon name="play" size={18} /></button>
                      : <button className="icon-btn" onClick={() => onPause(h.id)} disabled={st === 'done'} aria-label={t.stPause} data-tip={t.stPause}><Icon name="pause" size={18} /></button>}
                    <button className={`icon-btn${open === h.id ? ' on' : ''}`} onClick={() => setOpen(open === h.id ? null : h.id)} aria-expanded={open === h.id} aria-label={t.mineLog} data-tip={`${t.mineLog} (${h.log.length})`}><Icon name="list" size={18} /></button>
                    <button className="icon-btn" onClick={() => setRemoving(h)} aria-label={t.mineRemove} data-tip={t.mineRemove}><Icon name="trash" size={18} /></button>
                  </span>
                </div>
                {open === h.id && (
                  <ol className="tbl-log">
                    {!log.length && <li className="muted">{t.mineNoLog}</li>}
                    {log.slice(0, 40).map((e, i) => {
                      const x = eventLine(t, h, e);
                      return (
                        <li key={i}>
                          <time>{when(e.at)}</time>
                          <b>{x.label}</b>
                          <span>{x.detail}</span>
                          {x.link ? <a href={x.link} target="_blank" rel="noreferrer">{t.viewTx} ↗</a> : <span />}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      {!hired.length && (
        <div className="empty">
          <div className="empty-title">{t.mineEmpty}</div>
          <p className="muted">{t.mineEmptySub}</p>
          <button className="btn" onClick={onRecommend}><Spark size={14} />{t.barRecommend}</button>
        </div>
      )}

      <section className="info-card">
        <div className="info-title">{t.mineVault}{!vault?.configured && <span className="badge sig-wait"><i />{t.mineDemo}</span>}</div>
        {vault?.configured ? (
          <dl className="kv">
            <div><dt>{t.perTrade}</dt><dd>${vault.maxTradeUsdt}</dd></div>
            <div><dt>{t.perDay}</dt><dd>${vault.maxDailyUsdt}</dd></div>
            <div><dt>{t.leftToday}</dt><dd>${vault.remainingTodayUsdt}</dd></div>
            <div><dt>{t.balance}</dt><dd>{Number(vault.usdtBalance).toFixed(2)}</dd></div>
          </dl>
        ) : <p className="muted">{t.noVault}</p>}
        <p className="muted">{t.mineStopNote}</p>
      </section>

      {execs.length > 0 && (
        <section>
          <h2 className="home-h2">{t.mineManual}</h2>
          <div className="tbl">
            {execs.slice(0, 20).map((x, i) => (
              <div key={i} className="tbl-row exec">
                <span className="state"><i className={`chip-dot ${x.ok ? 'working' : 'paused'}`} aria-hidden />{x.side === 'buy' ? t.buy : t.sell} {x.asset}</span>
                <span className="muted">{x.ok ? `${x.amountIn} ${x.tokenIn} → ${Number(x.amountOut).toPrecision(6)} ${x.tokenOut}` : x.reason}</span>
                <span className="muted">{when(x.at)}</span>
                {x.explorerUrl ? <a href={x.explorerUrl} target="_blank" rel="noreferrer">{short(x.txHash)} ↗</a> : <span />}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
