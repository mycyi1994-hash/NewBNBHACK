// My agents: one place per agent. Each hired agent shows what it is doing, the money it was given and what it
// holds, with its controls; someone with none gets one ready to start, and the empty places invite another.
// The agents trade; the vault under them is the wallet they trade from, with the limits it enforces.
import { JournalBox, journalOf } from './Journal.tsx';
import { useMemo, useState } from 'react';
import { VaultCard } from './VaultCard.tsx';
import { useT } from './i18n.ts';
import type { Quote } from './market.ts';
import type { VaultInfo } from './parts.tsx';
import type { Execution } from './store.ts';
import { Modal, useToast } from './ui.tsx';
import { Icon, Spark } from './Icons.tsx';
import { book, statusOf, type HiredAgent } from './runner.ts';
import { eventLine, hiredName, money, moneyLine, qtyText, statusText } from './hiredText.ts';
import type { Agent } from './agents.ts';
import { agentName, Face, ruleLines } from './AgentCard.tsx';
import { readLevel, recommend } from './recommend.ts';
import { agentRows } from './portfolio.ts';
import { Portfolio, signedUsd } from './PortfolioRing.tsx';
import { RollNum } from './motion.tsx';
import { pct } from './AgentCard.tsx';
import type { CSSProperties } from 'react';
import { MyShared } from './Shared.tsx';

const loc = () => (document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR');
const when = (t: number) => new Date(t).toLocaleString(loc(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
/** How many places the page shows: your agents first, then empty places to add more, never fewer than this. */
const SLOTS = 3;

export default function MyAgents({ hired, quotes, vault, execs, now, agents, agentsFailed, onEdit, onPause, onResume, onRemove, onOpen, onRecommend, onStart, onMarket, onBuild }: {
  hired: HiredAgent[]; quotes: Quote[]; vault: VaultInfo | null; execs: Execution[]; now: number;
  agents: Agent[] | null; agentsFailed: boolean;
  onEdit: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void; onRemove: (id: string) => void;
  onOpen: (id: string) => void; onRecommend: () => void;
  /** Opens the hire sheet for the agent that is ready: it asks how much to give it, then the agent starts. */
  onStart: (a: Agent) => void; onMarket: () => void; onBuild: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [removing, setRemoving] = useState<HiredAgent | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Someone with no agent yet gets one ready to start: Moa's pick for bitcoin at the level they chose.
  const ready = useMemo(() => (hired.length || !agents ? null : recommend(agents, { coin: 'BTC', level: readLevel() })?.pick ?? null), [hired.length, agents]);
  const adds = Math.max(1, SLOTS - Math.max(1, hired.length));
  const priceOf = (a: string) => quotes.find((q) => q.asset === a)?.pool;
  const rows = agentRows(hired, priceOf, now);
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

      <ol className="slots" aria-label={t.mineTitle}>
        {hired.map((h, i) => {
          const st = statusOf(h, now);
          const r = rows[i];
          const b = book(h);
          const price = quotes.find((q) => q.asset === h.asset)?.pool;
          const m = moneyLine(t, h, price);
          const log = [...h.log].reverse();
          const frac = h.budgetUsd > 0 ? Math.min(1, b.spent / h.budgetUsd) : 0;
          return (
            <li key={h.id} className={`slot mine st-${st}${r.running ? ' run' : ''}`} style={{ '--agent': r.color } as CSSProperties}>
              <div className="slot-row">
                <span className={`slot-face${r.running ? ' orbit' : ''}`}>{h.source.type === 'market' ? <Face rule={h.source.rule} base={h.source.base} /> : <Icon name="bot" size={22} />}</span>
                <span className="slot-main">
                  <span className="slot-name"><button className="tbl-link" onClick={() => onOpen(h.id)}>{hiredName(t, h)}</button>{h.mode === 'auto' && <span className="auto-tag">{t.autoBadge}</span>}</span>
                  <span className="state">
                    {r.running && <span className="run-pill on"><i aria-hidden />{t.runOn}</span>}
                    <span className="state-text">{(!r.running || st === 'confirm') && <i className={`pf-dot ${st}`} aria-hidden />}{statusText(t, h, now)}</span>
                  </span>
                </span>
                <span className="slot-num slot-money">
                  <small>{t.slotMoney}</small>
                  <b>${money(b.spent)} <em>/ ${money(h.budgetUsd)}</em></b>
                  <span className="gauge" role="img" aria-label={`${Math.round(frac * 100)}%`}><i style={{ width: `${Math.round(frac * 100)}%` }} /></span>
                </span>
                <span className="slot-num slot-holds">
                  <small>{t.slotHolds}</small>
                  <b>{b.qty > 0 ? `${qtyText(b.qty)} ${h.asset}` : t.scNone}</b>
                  <small>{b.qty > 0 && price !== undefined ? <><span className="lbl">{t.scValue} </span>${money(b.qty * price)}</> : <><span className="lbl">{t.scPer} </span>${money(h.perBuyUsd)}</>}</small>
                </span>
                <span className={`slot-num slot-pnl ${r.pnl !== undefined ? m.cls : ''}`}>
                  <small>{t.thPnl}</small>
                  {r.pnl !== undefined ? <><b><RollNum text={signedUsd(r.pnl)} /></b>{r.pnlPct !== undefined && <em>{pct(r.pnlPct)}</em>}</> : <b className="none">{t.pfNoTrade}</b>}
                </span>
                <span className="tbl-actions">
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
                    // The order an event is about, with the inputs it was decided on (journal.ts).
                    const jr = journalOf(h, e);
                    return (
                      <li key={i}>
                        <time>{when(e.at)}</time>
                        <b>{x.label}</b>
                        <span>{x.detail}</span>
                        {x.link ? <a href={x.link} target="_blank" rel="noreferrer">{t.viewTx} ↗</a> : <span />}
                        {jr && <JournalBox j={jr} link={x.link} />}
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}

        {!hired.length && (
          <li className="slot ready">
            <div className="slot-row">
              {ready ? <>
                <span className="slot-face"><Face rule={ready.rule} base={ready.base} /></span>
                <span className="slot-main">
                  <span className="slot-name"><b>{agentName(t, ready)}</b><span className="ready-tag"><i aria-hidden />{t.slotReadyTag}</span></span>
                  <span className="slot-rules">{ready.made ? ruleLines(t, ready)[0] : t.agPlain[ready.rule]}</span>
                  <small className="muted">{t.slotReadySub}</small>
                </span>
                <span className="slot-go">
                  <button className="btn btn-primary" onClick={() => onStart(ready)}><Icon name="play" size={16} />{t.slotStart}</button>
                  <button className="btn-text" onClick={onMarket}>{t.slotSwap}</button>
                </span>
              </> : <>
                <span className="slot-face skel" aria-hidden />
                <span className="slot-main"><span className="slot-name"><b>{agentsFailed ? t.slotReadyFail : t.slotReadyLoading}</b></span></span>
                {agentsFailed && <span className="slot-go"><button className="btn" onClick={onMarket}>{t.slotMarket}</button></span>}
              </>}
            </div>
          </li>
        )}

        {Array.from({ length: adds }, (_, i) => (
          <li key={`add-${i}`} className={`slot add${i > 0 ? ' more' : ''}`}>
            <div className="slot-row">
              <span className="slot-face plus" aria-hidden><Icon name="plus" size={20} /></span>
              <span className="slot-main">
                <span className="slot-name"><b>{t.slotAdd}</b>{i > 0 && <b className="slot-more">{t.slotMore}</b>}</span>
                <small className="muted">{t.slotAddSub}</small>
              </span>
              <span className="slot-go">
                <button className="btn" onClick={onMarket}>{t.slotMarket}</button>
                <button className="btn-text" onClick={onBuild}>{t.slotBuild}</button>
              </span>
            </div>
          </li>
        ))}
      </ol>

      <Portfolio rows={rows} hired={hired} vault={vault} quotes={quotes} priceOf={priceOf} now={now} ready={ready} onStart={onStart} onOpen={onOpen} />

      {/* The agents this wallet made and shared, with their real hires and the fees the vaults paid it. */}
      <MyShared onBuild={onBuild} />

      <VaultCard vault={vault} />
      <p className="muted small">{t.mineStopNote}</p>

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
