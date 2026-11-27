// The lower half of "My agents": where the money is (a ring, by agent or by coin) and how each agent is doing
// (what it is doing now, its profit or loss, and its share). The ring, the rows and the slot cards above share one
// colour per agent. Every figure comes from the agents' fills, the vault and the live pool price; with nothing at
// work yet the section says so and shows the way in.
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { useT } from './i18n.ts';
import type { Quote } from './market.ts';
import type { VaultInfo } from './parts.tsx';
import type { Agent } from './agents.ts';
import { Icon } from './Icons.tsx';
import { RollNum, SlidePill } from './motion.tsx';
import { agentName, Face, pct } from './AgentCard.tsx';
import { hiredName, statusText } from './hiredText.ts';
import { coinSlices, totalPnl, type AgentRow, type PriceOf, type Slice } from './portfolio.ts';

/** Dollars with cents below $1,000 and thousands separators above. */
export const usd = (v: number) => (Math.abs(v) < 0.005 ? '$0' : `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2, maximumFractionDigits: 2 })}`);
export const signedUsd = (v: number) => `${v > 0.004 ? '+' : v < -0.004 ? '−' : ''}${usd(v)}`;
const tone = (v?: number) => (v === undefined ? '' : v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : '');
const share = (f: number) => `${f >= 0.995 || f < 0.005 ? Math.round(f * 100) : (f * 100).toFixed(f < 0.1 ? 1 : 0)}%`;

const R = 84, SW = 16, C = 2 * Math.PI * R, GAP = 3;

/** A donut of real slices. Hovering a slice (or its row) lifts it and the centre reads that slice instead of the total. */
function Ring({ slices, active, onActive, running, children }: {
  slices: Slice[]; active: string | null; onActive: (k: string | null) => void; running: boolean; children: ReactNode;
}) {
  const mask = useId().replace(/:/g, '');
  const total = slices.reduce((s, x) => s + x.value, 0);
  const gap = slices.length > 1 ? GAP : 0;
  let at = 0;
  return (
    <div className={`pf-ring${running ? ' pf-on' : ''}${total > 0 ? '' : ' pf-zero'}`}>
      <svg viewBox="0 0 220 220" role="img" aria-hidden>
        <defs>
          <mask id={mask}><circle className="pf-sweep" pathLength={1} cx="110" cy="110" r={R} fill="none" stroke="#fff" strokeWidth={SW + 12} /></mask>
        </defs>
        {total === 0 && <circle className="pf-track" cx="110" cy="110" r={R} fill="none" strokeWidth={SW} />}
        {total > 0 && (
          <g mask={`url(#${mask})`} transform="rotate(-90 110 110)">
            {slices.map((s) => {
              const len = Math.max(0.0001, (s.value / total) * C - gap);
              const el = (
                <circle key={s.key} cx="110" cy="110" r={R} fill="none" stroke={s.color}
                  className={`pf-seg${active === s.key ? ' on' : ''}${active && active !== s.key ? ' dim' : ''}`}
                  strokeWidth={SW} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-at - gap / 2}
                  onMouseEnter={() => onActive(s.key)} onMouseLeave={() => onActive(null)} />
              );
              at += (s.value / total) * C;
              return el;
            })}
          </g>
        )}
        {/* Something is at work: a quiet light travels the outer edge. */}
        {running && <g className="pf-orbit"><circle cx="110" cy="110" r={R + SW / 2 + 14} fill="none" stroke="none" /><circle cx="110" cy="110" r={R + SW / 2 + 9} fill="none" className="pf-orbit-track" /><circle cx="110" cy={110 - (R + SW / 2 + 9)} r="3.5" className="pf-orbit-dot" /></g>}
      </svg>
      <div className="pf-center">{children}</div>
    </div>
  );
}

export function Portfolio({ rows, hired, vault, quotes, priceOf, now, ready, onStart, onOpen }: {
  rows: AgentRow[]; hired: Parameters<typeof coinSlices>[1]; vault: VaultInfo | null; quotes: Quote[]; priceOf: PriceOf; now: number;
  ready: Agent | null; onStart: (a: Agent) => void; onOpen: (id: string) => void;
}) {
  const { t, lang } = useT();
  const [view, setView] = useState<'agent' | 'coin'>('agent');
  const [active, setActive] = useState<string | null>(null);
  const has = rows.length > 0;
  const mode = has ? view : 'coin';
  const coins = coinSlices(vault, hired, priceOf);
  const slices: Slice[] = mode === 'agent' ? rows.map((r) => ({ key: r.h.id, value: r.value, color: r.color })) : coins.slices;
  const total = slices.reduce((s, x) => s + x.value, 0);
  const running = rows.filter((r) => r.running).length;
  const tp = totalPnl(rows);
  const live = quotes.map((q) => (q.poolSource.state === 'live' ? q.poolSource.at : 0)).reduce((a, b) => Math.max(a, b), 0);
  const time = live ? new Date(live).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : '';

  // The centre: the hovered slice, or the whole.
  const hit = active ? slices.find((s) => s.key === active) : undefined;
  const hitRow = hit && mode === 'agent' ? rows.find((r) => r.h.id === hit.key) : undefined;
  const centerLabel = hit ? (hitRow ? hiredName(t, hitRow.h) : hit.key) : mode === 'agent' || (!has && total === 0) ? t.pfCenterAgents : coins.source === 'vault' ? t.pfCenterVault : t.pfCenterBooks;
  const centerSub = hit
    ? <span className="pf-c-sub">{share(total > 0 ? hit.value / total : 0)}{hitRow?.pnl !== undefined && <em className={tone(hitRow.pnl)}>{signedUsd(hitRow.pnl)}</em>}</span>
    : tp ? <span className={`pf-c-sub ${tone(tp.usd)}`}><RollNum text={signedUsd(tp.usd)} />{tp.pct !== undefined && <em>{pct(tp.pct)}</em>}</span>
      : has ? <span className="pf-c-sub muted">{t.pfNoTrade}</span>
        : total > 0 ? <span className="pf-c-sub muted">{t.pfVaultOnly}</span> : <span className="pf-c-sub muted">{t.pfEmptyCenter}</span>;

  return (
    <section className={`pf${has ? '' : ' pf-none'}`} aria-labelledby="pf-title">
      <header className="pf-head">
        <h2 id="pf-title">{t.pfTitle}</h2>
        <span className={`pf-live${running ? ' on' : ''}`}><i aria-hidden />{running ? t.pfRunning(running) : t.pfNoneRunning}</span>
        <span className="pf-price">{time ? t.pfPriceAt(time) : t.pfPriceWait}</span>
        {has && (
          <div className="depth-switch has-pill pf-switch" role="tablist" aria-label={t.pfView}>
            <SlidePill dep={view} />
            {(['agent', 'coin'] as const).map((v) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => { setView(v); setActive(null); }}>{v === 'agent' ? t.pfByAgent : t.pfByCoin}</button>)}
          </div>
        )}
      </header>

      <div className="pf-body">
        <div className="pf-left">
          <Ring slices={slices} active={active} onActive={setActive} running={running > 0}>
            <small>{centerLabel}</small>
            {/* the total rolls when prices move; a hovered slice just reads out, so pointing around stays calm */}
            {hit ? <b>{usd(hit.value)}</b> : <b><RollNum text={usd(total)} /></b>}
            {centerSub}
          </Ring>
          {mode === 'coin' && slices.length > 0 && (
            <ul className="pf-legend">
              {slices.map((s) => (
                <li key={s.key} className={active === s.key ? 'on' : ''} onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)}>
                  <i style={{ background: s.color }} aria-hidden />
                  <span>{s.key}</span>
                  <b>{usd(s.value)}</b>
                  <small>{share(s.value / total)}</small>
                </li>
              ))}
            </ul>
          )}
          {(has || total > 0) && <p className="pf-note">{mode === 'agent' ? t.pfNoteAgents : coins.source === 'vault' ? t.pfNoteVault : t.pfNoteBooks}</p>}
        </div>

        {has ? (
          <div className="pf-right">
            <div className="pf-row pf-row-head" aria-hidden>
              <span>{t.pfColAgent}</span><span>{t.pfColValue}</span><span>{t.pfColPnl}</span><span>{t.pfColShare}</span>
            </div>
            <ol className="pf-rows">
              {rows.map((r) => (
                <li key={r.h.id}>
                  <button className={`pf-row${r.running ? ' run' : ''} st-${r.status}${active === r.h.id ? ' on' : ''}${active && active !== r.h.id && mode === 'agent' ? ' dim' : ''}`}
                    style={{ '--agent': r.color } as CSSProperties}
                    onMouseEnter={() => mode === 'agent' && setActive(r.h.id)} onMouseLeave={() => mode === 'agent' && setActive(null)}
                    onFocus={() => mode === 'agent' && setActive(r.h.id)} onBlur={() => setActive(null)}
                    onClick={() => onOpen(r.h.id)}>
                    <span className="pf-who">
                      <span className={`pf-face${r.running ? ' orbit' : ''}`}>{r.h.source.type === 'market' ? <Face rule={r.h.source.rule} size="sm" /> : <span className="face sm"><Icon name="bot" size={16} /></span>}</span>
                      <span className="pf-name">
                        <b>{hiredName(t, r.h)}</b>
                        <small><i className={`pf-dot ${r.status}`} aria-hidden />{statusText(t, r.h, now)}</small>
                      </span>
                    </span>
                    <span className="pf-val">
                      <b><RollNum text={usd(r.value)} flash={false} /></b>
                      {r.atCost && <small>{t.pfAtCost}</small>}
                    </span>
                    <span className={`pf-pnl ${tone(r.pnl)}`}>
                      {r.pnl !== undefined ? <><b><RollNum text={signedUsd(r.pnl)} /></b>{r.pnlPct !== undefined && <small>{pct(r.pnlPct)}</small>}</> : <small className="muted">{t.pfNoTrade}</small>}
                    </span>
                    <span className="pf-share" aria-label={t.pfShareOf(share(r.share))}>
                      <b>{share(r.share)}</b>
                      <span className="pf-meter"><i style={{ width: `${(r.share * 100).toFixed(1)}%` }} /></span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="pf-right pf-empty">
            <span className="pf-empty-ic" aria-hidden><Icon name="chart" size={20} /></span>
            <h3>{t.pfEmptyTitle}</h3>
            <p>{t.pfEmptySub}</p>
            <ol className="pf-steps">
              {t.pfSteps.map((s, i) => <li key={i} className={i === 0 ? 'on' : ''}><span aria-hidden>{i + 1}</span>{s}</li>)}
            </ol>
            {ready && <button className="btn btn-primary" onClick={() => onStart(ready)}><Icon name="play" size={16} />{t.pfStartNamed(agentName(t, ready))}</button>}
          </div>
        )}
      </div>
    </section>
  );
}
