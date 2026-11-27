// A hired agent's working rules, as pure functions: what it holds, what it wants to do next, and the
// one-word state the bar shows. Two ways of working, chosen in the hire sheet:
//  - "ask": the app calls decide() on a timer while it is open, and every order waits for the user's OK;
//  - "auto": the server calls the same decide() on its own timer and sends the order at once, app open or not.
// Either way the order goes to the owner's vault, which enforces the owner's limits again.
import type { Asset, Plan } from './intent.ts';
import type { Agent, RuleId } from './agents.ts';
import type { MadeSpec } from './spec.ts';

export type Mode = 'ask' | 'auto';

export const DAY = 86_400_000;
const PERIOD = { hour: 3_600_000, day: DAY, week: 7 * DAY } as const;
const TINY = 1e-12;

export type Side = 'buy' | 'sell';
export type Why =
  | { k: 'signalOn' }
  | { k: 'signalOff' }
  | { k: 'weight'; pct: number }
  | { k: 'daily'; mult: number }
  | { k: 'plan' }
  | { k: 'stop'; pct: number; key: string }
  | { k: 'take'; pct: number; key: string };
export type SkipWhy = { k: 'belowMa' } | { k: 'tooSmall' } | { k: 'overMax'; max: number };
export interface Order { id: string; at: number; side: Side; usd?: number; qty?: number; why: Why }
export interface Fill { at: number; side: Side; usd: number; qty: number; txHash?: string; explorerUrl?: string }
export interface Amounts { perBuyUsd: number; budgetUsd: number }
/** What the hire sheet hands back: the amounts and how the agent should work. */
export interface HireChoice extends Amounts { mode: Mode }
export type LogEvent =
  | { at: number; k: 'hired'; to: Amounts }
  | { at: number; k: 'asked'; order: Order }
  | { at: number; k: 'filled'; orderId: string; fill: Fill }
  | { at: number; k: 'declined'; orderId: string }
  | { at: number; k: 'failed'; orderId: string; reason: string; demo?: boolean }
  | { at: number; k: 'expired'; orderId: string }
  | { at: number; k: 'skipped'; why: SkipWhy }
  | { at: number; k: 'paused' }
  | { at: number; k: 'resumed' }
  | { at: number; k: 'changed'; from: Amounts; to: Amounts };

export type Source =
  | { type: 'market'; agentId: string; kind: 'position' | 'collect'; rule: RuleId; base: string }
  | { type: 'custom'; goal: string; plan: Plan };

export interface HiredAgent extends Amounts {
  id: string;
  createdAt: number;
  source: Source;
  asset: Asset;
  mode: Mode;
  /** The rule of an agent the user made, carried along so the server can run it without the browser. */
  spec?: MadeSpec;
  paused: boolean;
  pending?: Order;
  /** Last time a collect or plan buy was asked, filled, skipped or declined. */
  lastRunAt?: number;
  /** Position agents: the side the user declined, so it does not ask again until the signal flips. */
  declined?: Side;
  /** Plan guards (stop-loss, take-profit) that already fired. */
  fired: string[];
  fills: Fill[];
  log: LogEvent[];
}

export type Signal =
  | { kind: 'position'; live: boolean }
  /** A weight agent: the share of its budget it wants in the coin now, the band it rebalances on, and the coin's price. */
  | { kind: 'weight'; target: number; band: number; price: number }
  | { kind: 'collect'; mult: number }
  | { kind: 'custom'; price?: number };
export type Decision =
  | { type: 'order'; order: Omit<Order, 'id' | 'at'> }
  | { type: 'skip'; why: SkipWhy }
  | { type: 'cancel' }
  | { type: 'idle'; clearDeclined?: boolean };

const cents = (v: number) => Math.floor(v * 100 + 1e-9) / 100;

/** Coins held, money spent on buys, money back from sells, and the average cost of what is left. */
export function book(h: Pick<HiredAgent, 'fills'>) {
  let qty = 0, basis = 0, spent = 0, proceeds = 0;
  for (const f of h.fills) {
    if (f.side === 'buy') { qty += f.qty; basis += f.usd; spent += f.usd; continue; }
    const share = qty > TINY ? Math.min(1, f.qty / qty) : 1;
    basis -= basis * share;
    qty = Math.max(0, qty - f.qty);
    proceeds += f.usd;
  }
  return { qty: qty > TINY ? qty : 0, basis, spent, proceeds, avg: qty > TINY ? basis / qty : undefined };
}

export const leftToSpend = (h: HiredAgent) => Math.max(0, h.budgetUsd - book(h).spent);

/** Profit or loss since hiring, at the given price. Undefined before the first fill. */
export function pnl(h: HiredAgent, price?: number): number | undefined {
  if (!h.fills.length || price === undefined) return undefined;
  const b = book(h);
  return b.qty * price + b.proceeds - b.spent;
}

const accumulateStep = (h: HiredAgent) =>
  h.source.type === 'custom' ? h.source.plan.steps.find((s) => s.kind === 'accumulate' && s.asset === h.asset) : undefined;

/** The next thing the agent wants. Idempotent: calling it again on the updated agent returns idle. */
export function decide(h: HiredAgent, s: Signal, now: number, opts: { maxTradeUsd?: number } = {}): Decision {
  if (h.paused) return { type: 'idle' };
  const b = book(h);
  const left = Math.max(0, h.budgetUsd - b.spent);
  const cap = (usd: number) => cents(Math.min(usd, left, opts.maxTradeUsd ?? Infinity));

  if (s.kind === 'weight') return decideWeight(h, s, b, opts);

  if (s.kind === 'position') {
    const want: Side | null = b.qty > 0 && !s.live ? 'sell' : b.qty === 0 && s.live && left >= 1 ? 'buy' : null;
    if (h.pending) return h.pending.side !== want ? { type: 'cancel' } : { type: 'idle' };
    if (!want) return { type: 'idle', clearDeclined: !!h.declined };
    if (h.declined === want) return { type: 'idle' };
    if (want === 'sell') return { type: 'order', order: { side: 'sell', qty: b.qty, why: { k: 'signalOff' } } };
    const usd = cap(h.perBuyUsd);
    return usd >= 1 ? { type: 'order', order: { side: 'buy', usd, why: { k: 'signalOn' } } } : { type: 'idle' };
  }

  if (h.pending) return { type: 'idle' };

  if (s.kind === 'collect') {
    if (h.lastRunAt !== undefined && now - h.lastRunAt < DAY) return { type: 'idle' };
    if (left < 1) return { type: 'idle' };
    if (s.mult <= 0) return { type: 'skip', why: { k: 'belowMa' } };
    const usd = cap(h.perBuyUsd * s.mult);
    return usd >= 1 ? { type: 'order', order: { side: 'buy', usd, why: { k: 'daily', mult: s.mult } } } : { type: 'skip', why: { k: 'tooSmall' } };
  }

  // A custom plan from the conversation: guards first, then the next scheduled buy.
  if (h.source.type !== 'custom' || s.price === undefined) return { type: 'idle' };
  const price = s.price;
  const steps = h.source.plan.steps;
  if (b.qty > 0 && b.avg !== undefined) {
    for (let j = 0; j < steps.length; j++) {
      const st = steps[j];
      if (st.kind === 'stopLoss' && st.asset === h.asset && !h.fired.includes(`stop:${j}`) && price <= b.avg * (1 - st.dropPct / 100))
        return { type: 'order', order: { side: 'sell', qty: b.qty * st.sellFraction, why: { k: 'stop', pct: st.dropPct, key: `stop:${j}` } } };
      if (st.kind === 'takeProfit' && st.asset === h.asset && !h.fired.includes(`take:${j}`) && price >= b.avg * (1 + st.risePct / 100))
        return { type: 'order', order: { side: 'sell', qty: b.qty * st.sellFraction, why: { k: 'take', pct: st.risePct, key: `take:${j}` } } };
    }
  }
  const acc = accumulateStep(h);
  if (!acc || acc.kind !== 'accumulate') return { type: 'idle' };
  if (h.lastRunAt !== undefined && now - h.lastRunAt < PERIOD[acc.every ?? 'day']) return { type: 'idle' };
  if (acc.durationDays !== undefined && now > h.createdAt + acc.durationDays * DAY) return { type: 'idle' };
  if (acc.targetQty !== undefined && b.qty >= acc.targetQty) return { type: 'idle' };
  if (left < 1) return { type: 'idle' };
  if (acc.maxPrice !== undefined && price > acc.maxPrice) return { type: 'skip', why: { k: 'overMax', max: acc.maxPrice } };
  const usd = cap(h.perBuyUsd);
  return usd >= 1 ? { type: 'order', order: { side: 'buy', usd, why: { k: 'plan' } } } : { type: 'skip', why: { k: 'tooSmall' } };
}

/**
 * A weight agent's next order. Its position is its target share × its own budget: it buys or sells the difference,
 * at the coin's price, once the share it holds is `band` or more away from the target. A buy never takes the cost of
 * what it holds past the budget, and stays within the vault's per-trade limit; a sell never sells more than it holds.
 */
function decideWeight(h: HiredAgent, s: Extract<Signal, { kind: 'weight' }>, b: ReturnType<typeof book>, opts: { maxTradeUsd?: number }): Decision {
  if (!(s.price > 0) || !(h.budgetUsd > 0)) return { type: 'idle' };
  const goal = Math.min(1, Math.max(0, Number.isFinite(s.target) ? s.target : 0));
  const value = b.qty * s.price, held = value / h.budgetUsd;
  const want: Side | null = Math.abs(goal - held) >= s.band - 1e-9 ? (goal > held ? 'buy' : 'sell') : null;
  if (h.pending) return h.pending.side !== want ? { type: 'cancel' } : { type: 'idle' };
  if (!want) return { type: 'idle', clearDeclined: !!h.declined };
  if (h.declined === want) return { type: 'idle' };
  const why: Why = { k: 'weight', pct: Math.round(goal * 100) };
  if (want === 'sell') {
    const qty = goal === 0 ? b.qty : Math.min(b.qty, (value - goal * h.budgetUsd) / s.price);
    return qty > TINY ? { type: 'order', order: { side: 'sell', qty, why } } : { type: 'idle' };
  }
  const room = Math.max(0, h.budgetUsd - b.basis);
  const usd = cents(Math.min(goal * h.budgetUsd - value, room, opts.maxTradeUsd ?? Infinity));
  return usd >= 1 ? { type: 'order', order: { side: 'buy', usd, why } } : { type: 'idle' };
}

/** What an agent's backtest says to do now, as the runner reads it: a weight, in or out, or today's collect multiple. */
export function agentSignal(a: Pick<Agent, 'kind' | 'live' | 'mult' | 'target' | 'band' | 'price'>): Signal {
  if (a.kind === 'collect') return { kind: 'collect', mult: a.mult };
  return a.target !== undefined ? { kind: 'weight', target: a.target, band: a.band ?? 0.1, price: a.price } : { kind: 'position', live: a.live };
}

export type Status = 'paused' | 'confirm' | 'done' | 'working' | 'waiting';

/** One word for the bar. "working" means it holds coins or already acted in this period. */
export function statusOf(h: HiredAgent, now: number): Status {
  if (h.paused) return 'paused';
  if (h.pending) return 'confirm';
  const b = book(h);
  const left = h.budgetUsd - b.spent;
  if (h.source.type === 'market' && h.source.kind === 'position') return b.qty > 0 ? 'working' : left < 1 ? 'done' : 'waiting';
  if (h.source.type === 'market') return left < 1 ? 'done' : h.lastRunAt !== undefined && now - h.lastRunAt < DAY ? 'working' : 'waiting';
  const acc = accumulateStep(h);
  const period = acc?.kind === 'accumulate' ? PERIOD[acc.every ?? 'day'] : DAY;
  const ended = acc?.kind === 'accumulate' && acc.durationDays !== undefined && now > h.createdAt + acc.durationDays * DAY;
  if (left < 1 || ended || !acc) {
    const guards = h.source.plan.steps.some((st, j) => (st.kind === 'stopLoss' || st.kind === 'takeProfit') && !h.fired.includes(`${st.kind === 'stopLoss' ? 'stop' : 'take'}:${j}`));
    return guards && b.qty > 0 ? 'working' : 'done';
  }
  return h.lastRunAt !== undefined && now - h.lastRunAt < period ? 'working' : 'waiting';
}

/** The last event of the given kinds, newest first. */
export function lastEvent<K extends LogEvent['k']>(h: HiredAgent, ...kinds: K[]): Extract<LogEvent, { k: K }> | undefined {
  for (let i = h.log.length - 1; i >= 0; i--) if ((kinds as string[]).includes(h.log[i].k)) return h.log[i] as Extract<LogEvent, { k: K }>;
  return undefined;
}

/** The note stored on-chain with the trade (the vault keeps 120 characters). */
export function chainNote(name: string, why: Why, mode: Mode = 'ask'): string {
  const w = why.k === 'signalOn' ? 'signal on' : why.k === 'signalOff' ? 'signal off' : why.k === 'weight' ? `rebalance to ${why.pct}%` : why.k === 'daily' ? `daily buy x${why.mult}`
    : why.k === 'plan' ? 'plan buy' : why.k === 'stop' ? `stop-loss -${why.pct}%` : `take-profit +${why.pct}%`;
  return `Moa agent ${name}: ${w}, ${mode === 'auto' ? 'standing order from the owner' : 'approved by the owner'}`.slice(0, 120);
}

export const newId = () => Math.random().toString(36).slice(2, 10);

/** What came back from the vault for one order. */
export type Outcome =
  | { ok: true; amountIn: string; amountOut: string; txHash?: string; explorerUrl?: string }
  | { ok: false; reason: string; demo?: boolean };

/**
 * The agent after one of its orders was sent: the fill on its books, or the failure in its log. A failed or refused
 * order is not retried at once: a position agent waits for its signal to flip, a collect agent for its next period.
 */
export function settle(h: HiredAgent, o: Order, r: Outcome, at: number): HiredAgent {
  const position = h.source.type === 'market' && h.source.kind === 'position';
  const key = 'key' in o.why ? o.why.key : undefined;
  const base = { ...h, pending: h.pending?.id === o.id ? undefined : h.pending, fired: key && !h.fired.includes(key) ? [...h.fired, key] : h.fired };
  if (r.ok) {
    const fill: Fill = { at, side: o.side, usd: Number(o.side === 'buy' ? r.amountIn : r.amountOut), qty: Number(o.side === 'buy' ? r.amountOut : r.amountIn), txHash: r.txHash, explorerUrl: r.explorerUrl };
    return { ...base, fills: [...h.fills, fill], lastRunAt: o.side === 'buy' ? at : h.lastRunAt, log: [...h.log, { at, k: 'filled', orderId: o.id, fill }] };
  }
  return { ...base, declined: position ? o.side : h.declined, lastRunAt: position || o.side === 'sell' ? h.lastRunAt : at, log: [...h.log, { at, k: 'failed', orderId: o.id, reason: r.reason, demo: r.demo }] };
}
