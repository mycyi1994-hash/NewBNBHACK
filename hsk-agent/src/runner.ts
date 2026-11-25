// A hired agent's working rules, as pure functions: what it holds, what it wants to do next, and the
// one-word state the bar shows. The app calls decide() on a timer while it is open; every order waits for
// the user's OK ("ask before each trade") and then goes to the vault, which enforces its own limits.
import type { Asset, Plan } from './intent.ts';
import type { RuleId } from './agents.ts';

export const DAY = 86_400_000;
const PERIOD = { hour: 3_600_000, day: DAY, week: 7 * DAY } as const;
const TINY = 1e-12;

export type Side = 'buy' | 'sell';
export type Why =
  | { k: 'signalOn' }
  | { k: 'signalOff' }
  | { k: 'daily'; mult: number }
  | { k: 'plan' }
  | { k: 'stop'; pct: number; key: string }
  | { k: 'take'; pct: number; key: string };
export type SkipWhy = { k: 'belowMa' } | { k: 'tooSmall' } | { k: 'overMax'; max: number };
export interface Order { id: string; at: number; side: Side; usd?: number; qty?: number; why: Why }
export interface Fill { at: number; side: Side; usd: number; qty: number; txHash?: string; explorerUrl?: string }
export interface Amounts { perBuyUsd: number; budgetUsd: number }
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
  mode: 'ask';
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
export function chainNote(name: string, why: Why): string {
  const w = why.k === 'signalOn' ? 'signal on' : why.k === 'signalOff' ? 'signal off' : why.k === 'daily' ? `daily buy x${why.mult}`
    : why.k === 'plan' ? 'plan buy' : why.k === 'stop' ? `stop-loss -${why.pct}%` : `take-profit +${why.pct}%`;
  return `Moa agent ${name}: ${w}, approved by the owner`.slice(0, 120);
}

export const newId = () => Math.random().toString(36).slice(2, 10);
