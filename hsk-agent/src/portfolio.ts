// The numbers behind the portfolio ring on "My agents", as pure functions. Nothing here is estimated:
// an agent is worth its money plus its profit or loss at the current price, and the coin view is either what the
// vault holds (when one is connected) or the sum of the agents' own books.
import { book, pnl, statusOf, type HiredAgent, type Status } from './runner.ts';
import type { Asset } from './intent.ts';
import type { VaultInfo } from './parts.tsx';

/** Categorical colours, in a fixed order (validated for colour-blind separation on white). */
export const AGENT_COLORS = ['#257de0', '#f47230', '#00b894', '#f2a600', '#ee7fac', '#008a17', '#6a4ce2', '#ec4647'];
export const OTHER_COLOR = '#9aa0a6';
/** Coins keep one colour each, ordered so neighbours on the ring stay apart. */
export const COIN_ORDER = ['USDT', 'ETH', 'BTC', 'HSK'] as const;
export type CoinKey = typeof COIN_ORDER[number];
export const COIN_COLORS: Record<CoinKey, string> = { USDT: '#00b894', ETH: '#257de0', BTC: '#f47230', HSK: '#6a4ce2' };

export interface AgentRow {
  h: HiredAgent;
  color: string;
  /** Money given + profit or loss: what is left of its budget, what its sells brought back, and its coins now. */
  value: number;
  /** True when it holds coins but there is no price yet, so they are counted at what they cost. */
  atCost: boolean;
  /** Undefined before the first fill or without a price. */
  pnl?: number;
  /** pnl over the money spent on buys. */
  pnlPct?: number;
  /** Its part of all the agents' value, 0..1. */
  share: number;
  status: Status;
  /** Not paused and not finished: it is watching the market and will act. */
  running: boolean;
}

export type PriceOf = (a: Asset) => number | undefined;

/** Colours follow the agent, not its rank: oldest hire first, so a new agent never repaints the others. */
export function agentColors(hired: HiredAgent[]): Map<string, string> {
  const order = [...hired].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return new Map(order.map((h, i) => [h.id, AGENT_COLORS[i] ?? OTHER_COLOR]));
}

export function agentRows(hired: HiredAgent[], priceOf: PriceOf, now: number): AgentRow[] {
  const colors = agentColors(hired);
  const rows = hired.map((h) => {
    const b = book(h);
    const price = priceOf(h.asset);
    const p = pnl(h, price);
    const coins = b.qty > 0 ? (price !== undefined ? b.qty * price : b.basis) : 0;
    const value = Math.max(0, h.budgetUsd - b.spent) + b.proceeds + coins;
    const status = statusOf(h, now);
    return {
      h, color: colors.get(h.id) ?? OTHER_COLOR, value, atCost: b.qty > 0 && price === undefined,
      pnl: p, pnlPct: p !== undefined && b.spent > 0 ? p / b.spent : undefined, share: 0, status,
      running: status !== 'paused' && status !== 'done',
    };
  });
  const total = rows.reduce((s, r) => s + r.value, 0);
  for (const r of rows) r.share = total > 0 ? r.value / total : 0;
  return rows;
}

/** The sum of the agents' profit or loss, and that sum over what they spent. Undefined while nothing has filled. */
export function totalPnl(rows: AgentRow[]): { usd: number; pct?: number } | undefined {
  const done = rows.filter((r) => r.pnl !== undefined);
  if (!done.length) return undefined;
  const usd = done.reduce((s, r) => s + r.pnl!, 0);
  const spent = done.reduce((s, r) => s + book(r.h).spent, 0);
  return { usd, pct: spent > 0 ? usd / spent : undefined };
}

export interface Slice { key: string; value: number; color: string }

const coinOf = (symbol: string): CoinKey | undefined => {
  const s = symbol.toUpperCase().replace(/^W(?=BTC|ETH|HSK)/, '');
  return (COIN_ORDER as readonly string[]).includes(s) ? (s as CoinKey) : undefined;
};

/**
 * By coin. With a vault: its idle USDT and each coin's value as the vault reports it (or at the current price when
 * the vault gave no value). Without one: the agents' books, unspent money as USDT and coins at the current price.
 */
export function coinSlices(vault: VaultInfo | null, hired: HiredAgent[], priceOf: PriceOf): { source: 'vault' | 'books'; slices: Slice[] } {
  const sum: Record<CoinKey, number> = { USDT: 0, ETH: 0, BTC: 0, HSK: 0 };
  if (vault?.configured) {
    const usdt = Number(vault.usdtBalance);
    if (Number.isFinite(usdt)) sum.USDT += usdt;
    for (const x of vault.holdings ?? []) {
      const c = coinOf(x.symbol);
      if (!c || c === 'USDT') continue;
      const v = x.valueUsdt !== undefined ? Number(x.valueUsdt) : Number(x.amount) * (priceOf(c as Asset) ?? NaN);
      if (Number.isFinite(v) && v > 0) sum[c] += v;
    }
    return { source: 'vault', slices: COIN_ORDER.map((k) => ({ key: k, value: sum[k], color: COIN_COLORS[k] })).filter((s) => s.value > 0.005) };
  }
  for (const h of hired) {
    const b = book(h);
    sum.USDT += Math.max(0, h.budgetUsd - b.spent) + b.proceeds;
    if (b.qty > 0) { const price = priceOf(h.asset); sum[h.asset as CoinKey] += price !== undefined ? b.qty * price : b.basis; }
  }
  return { source: 'books', slices: COIN_ORDER.map((k) => ({ key: k, value: sum[k], color: COIN_COLORS[k] })).filter((s) => s.value > 0.005) };
}
