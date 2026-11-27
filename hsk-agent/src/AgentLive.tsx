// A hired agent as it shows up in Moa's conversation: the moment it is given money (HireCard) and its state
// when asked about it later (StatusCard). Both read the agent's own record and the live price, wear the agent's
// colour (the same one as on "My agents" and in the top bar), and move only while the agent is running.
import type { CSSProperties } from 'react';
import { useT, type Strings } from './i18n.ts';
import { Face, pct, ruleLines } from './AgentCard.tsx';
import { Icon } from './Icons.tsx';
import { RollNum } from './motion.tsx';
import { book, pnl, statusOf, type HiredAgent, type Status } from './runner.ts';
import { hiredName, money, qtyText, signedMoney, statusText } from './hiredText.ts';

/** Running = watching the market and able to act (not paused, not finished). */
export const isRunning = (st: Status) => st !== 'paused' && st !== 'done';

/** The agent's mark: its face, or the bot icon for a plan made in conversation. */
export function Mark({ h, size = 'md' }: { h: HiredAgent; size?: 'sm' | 'md' | 'lg' }) {
  return h.source.type === 'market' ? <Face rule={h.source.rule} size={size} /> : <span className={`face ${size}`}><Icon name="bot" size={size === 'sm' ? 16 : 20} /></span>;
}

/** What the agent does, in one plain line, from the rule's own text (nothing new is claimed). */
export function ruleLine(t: Strings, h: HiredAgent): string {
  if (h.source.type === 'custom') return h.source.goal;
  if (h.source.rule === 'made') return h.spec ? ruleLines(t, { rule: 'made', made: h.spec })[0] : '';
  return t.agLine[h.source.rule] ?? '';
}

/** The state as one coloured word: green while running, amber when it waits for you, grey when stopped. */
export function StatePill({ h, now }: { h: HiredAgent; now: number }) {
  const { t } = useT();
  const st = statusOf(h, now);
  const k = st === 'confirm' ? 'ask' : isRunning(st) ? 'on' : 'off';
  return <span className={`st-pill ${k}`}><i aria-hidden />{statusText(t, h, now)}</span>;
}

/** Handed money a moment ago: the agent, the money it was given, what it waits for, and where to follow it. */
export function HireCard({ h, color, now, onView, onPause, onResume }: {
  h: HiredAgent; color: string; now: number; onView: () => void; onPause: () => void; onResume: () => void;
}) {
  const { t } = useT();
  const st = statusOf(h, now);
  const run = isRunning(st);
  const name = hiredName(t, h);
  const line = ruleLine(t, h);
  return (
    <div className={`hire-card${run ? ' run' : ''}`} style={{ '--agent': color } as CSSProperties}>
      <div className="hc-top">
        <span className={`hc-mark${run ? ' orbit' : ''}`}>
          {run && <><i className="hc-ripple" aria-hidden /><i className="hc-ripple two" aria-hidden /></>}
          <Mark h={h} size="lg" />
        </span>
        <span className="hc-title">
          <b>{h.paused ? t.hcPaused(name) : h.mode === 'auto' ? t.hcOnAuto(name) : t.hcOnAsk(name)}</b>
          <StatePill h={h} now={now} />
        </span>
      </div>
      <div className="hc-money">
        <b>${money(h.budgetUsd)}</b><span>{t.hcGiven}</span>
        <small>{t.hcPer(money(h.perBuyUsd))} · {h.mode === 'auto' ? t.hcAuto : t.hcAsk}</small>
      </div>
      {line && <p className="hc-rule">{line}</p>}
      <div className="hc-actions">
        <button className="btn btn-primary" onClick={onView}>{t.hcView}</button>
        {h.paused ? <button className="btn-text" onClick={onResume}>{t.stResume}</button> : st !== 'done' && <button className="btn-text" onClick={onPause}>{t.stPause}</button>}
      </div>
    </div>
  );
}

/** Asked about later: state and profit at a glance, the money as one gauge, and the controls. */
export function StatusCard({ h, color, price, now, onEdit, onPause, onResume, onLog }: {
  h: HiredAgent; color: string; price?: number; now: number; onEdit: () => void; onPause: () => void; onResume: () => void; onLog: () => void;
}) {
  const { t } = useT();
  const st = statusOf(h, now);
  const run = isRunning(st);
  const b = book(h);
  const p = pnl(h, price);
  const frac = h.budgetUsd > 0 ? Math.min(1, b.spent / h.budgetUsd) : 0;
  const tone = p === undefined ? '' : p > 0.004 ? 'pos' : p < -0.004 ? 'neg' : '';
  return (
    <div className={`status-card sc2 st-${st}${run ? ' run' : ''}`} style={{ '--agent': color } as CSSProperties}>
      <div className="sc2-top">
        <span className={`sc2-mark${run ? ' orbit' : ''}`}><Mark h={h} size="md" /></span>
        <span className="sc2-name"><b>{hiredName(t, h)}</b><StatePill h={h} now={now} /></span>
        <span className={`sc2-pnl ${tone}`}>
          {p !== undefined ? <><b><RollNum text={signedMoney(p)} /></b>{b.spent > 0 && <small>{pct(p / b.spent)}</small>}</> : <small>{t.pfNoTrade}</small>}
        </span>
      </div>
      <div className="sc2-money">
        <span className="gauge" role="img" aria-label={`${Math.round(frac * 100)}%`}><i style={{ width: `${Math.round(frac * 100)}%` }} /></span>
        <span>{t.scUsed(money(b.spent), money(h.budgetUsd))}</span>
        {b.qty > 0 && <span className="sc2-held">{qtyText(b.qty)} {h.asset}{price !== undefined ? ` · $${money(b.qty * price)}` : ''}</span>}
      </div>
      <div className="status-actions">
        <button className="btn-ghost sm" onClick={onEdit}>{t.scEdit}</button>
        {h.paused ? <button className="btn-ghost sm" onClick={onResume}>{t.stResume}</button> : st !== 'done' && <button className="btn-ghost sm" onClick={onPause}>{t.stPause}</button>}
        <button className="btn-ghost sm" onClick={onLog}>{t.scLog}</button>
      </div>
    </div>
  );
}
