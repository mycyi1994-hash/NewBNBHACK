// Words for a hired agent, shared by the bar, the My agents page and Moa's cards.
import type { Strings } from './i18n.ts';
import { agentName } from './AgentCard.tsx';
import { book, lastEvent, pnl, statusOf, DAY, type HiredAgent, type LogEvent, type SkipWhy, type Why } from './runner.ts';

export const money = (v: number) => (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(2));
export const qtyText = (q: number) => (q >= 1 ? Number(q.toFixed(4)).toString() : Number(q.toPrecision(4)).toString());
export const signedMoney = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${money(Math.abs(v))}`;

export function hiredName(t: Strings, h: HiredAgent): string {
  // A made agent's name travels in its rule, so one someone else made and shared is named too.
  return h.source.type === 'market' ? agentName(t, { ...h.source, made: h.spec }) : t.customName(h.asset);
}

export function whyText(t: Strings, w: Why): string {
  switch (w.k) {
    case 'signalOn': return t.whySignalOn;
    case 'signalOff': return t.whySignalOff;
    case 'weight': return t.whyWeight(w.pct);
    case 'daily': return t.whyDaily(String(Math.round(w.mult * 100) / 100));
    case 'plan': return t.whyPlan;
    case 'stop': return t.whyStop(w.pct);
    case 'take': return t.whyTake(w.pct);
  }
}

export function skipText(t: Strings, w: SkipWhy): string {
  return w.k === 'belowMa' ? t.skipBelowMa : w.k === 'tooSmall' ? t.skipTooSmall : t.skipOverMax(money(w.max));
}

/** The bar's short line: what the agent is doing now. */
export function statusText(t: Strings, h: HiredAgent, now: number): string {
  const st = statusOf(h, now);
  if (st === 'paused') return t.stPaused;
  if (st === 'done') return t.stDone;
  if (st === 'confirm') return h.pending?.side === 'buy' ? t.stAskBuy(money(h.pending.usd ?? 0)) : t.stAskSell;
  if (h.source.type === 'market' && h.source.kind === 'position') return st === 'working' ? t.stHolding : t.stWaitSignal;
  if (st === 'working') {
    const e = lastEvent(h, 'filled', 'skipped', 'declined', 'failed');
    if (e?.k === 'filled' && now - e.at < DAY && e.fill.side === 'buy') return t.stBought(money(e.fill.usd));
    if (e && now - e.at < DAY && e.k === 'failed') return t.stNotSent;
    if (e && now - e.at < DAY && e.k !== 'filled') return t.stSkipped;
    return t.stHolding;
  }
  return t.stNext;
}

/** Profit since hiring once something filled; until then, how much of the budget is used. */
export function moneyLine(t: Strings, h: HiredAgent, price?: number): { text: string; cls: string } {
  const p = pnl(h, price);
  if (p !== undefined) return { text: signedMoney(p), cls: p > 0.004 ? 'pos' : p < -0.004 ? 'neg' : '' };
  return { text: t.stSpentOf(money(book(h).spent), money(h.budgetUsd)), cls: '' };
}

/** One line of the record list. */
export function eventLine(t: Strings, h: HiredAgent, e: LogEvent): { label: string; detail?: string; link?: string } {
  switch (e.k) {
    case 'hired': return { label: t.evHired(money(e.to.perBuyUsd), money(e.to.budgetUsd)) };
    case 'asked': return { label: t.evAsked, detail: `${e.order.side === 'buy' ? t.stAskBuy(money(e.order.usd ?? 0)) : t.stAskSell} ${whyText(t, e.order.why)}` };
    case 'filled': return {
      label: t.evFilled,
      detail: e.fill.side === 'buy' ? t.filledBuy(money(e.fill.usd), qtyText(e.fill.qty), h.asset) : t.filledSell(qtyText(e.fill.qty), h.asset, money(e.fill.usd)),
      link: e.fill.explorerUrl,
    };
    case 'declined': return { label: t.evDeclined };
    case 'failed': return { label: t.evFailed, detail: e.demo ? t.obDemoDone : e.reason };
    case 'expired': return { label: t.evExpired };
    case 'skipped': return { label: t.evSkipped, detail: skipText(t, e.why) };
    case 'paused': return { label: t.evPaused };
    case 'resumed': return { label: t.evResumed };
    case 'changed': return { label: t.evChanged, detail: `$${money(e.from.perBuyUsd)} / $${money(e.from.budgetUsd)} → $${money(e.to.perBuyUsd)} / $${money(e.to.budgetUsd)}` };
  }
}
