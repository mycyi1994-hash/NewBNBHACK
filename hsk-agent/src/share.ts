// Sharing a made agent: the rule (plain data, see spec.ts), its name, who made it and the fee they ask.
// The server keeps the shared agents (server/shareStore.ts); this file is the part both sides agree on:
// how a rule that arrives from someone else is checked and cleaned, the fee choices, and the link.
// A creator fee is paid by the hirer's own vault, only once its owner approves it, and never above 1%
// (MoaVault.MAX_CREATOR_FEE_BPS). There is no platform fee.
import { MAX_CONDS, SPEC_INTERVALS, TEMPLATE_IDS, TERM_KINDS, problems, type Cond, type MadeSpec, type Term } from './spec.ts';

/** What a hired agent carries about the person who made it. The server fills `creator` and `feeBps` from its own record. */
export interface SharedRef { id: string; creator: string; nick?: string; feeBps: number }
/** What a shared agent's card shows beside its backtest. */
export interface SharedTag extends SharedRef { hires?: number; removedAt?: number }
/** A shared agent as the server lists it. `hires` is counted by the server: one per wallet that hired it, the creator not included. */
export interface SharedAgent extends SharedRef {
  spec: MadeSpec;
  createdAt: number;
  /** Set when the creator stopped sharing it. Those who hired it keep their copy. */
  removedAt?: number;
  hires: number;
  /** Only in the creator's own list: the id of the made agent it was shared from. */
  sourceId?: string;
}

/** The contract's cap: 100 basis points = 1% of a trade. */
export const MAX_FEE_BPS = 100;
/** The fees a creator can pick from: none, 0.1%, 0.25%, 0.5%, 1%. */
/**
 * Whether a new share may ask for a creator fee. Off: the vaults on mainnet are version 2, which has no fee path, so a
 * fee picked here could not be paid. Turn on when version-3 vaults are what people get.
 */
export const FEES_LIVE = false;
export const FEE_CHOICES = [0, 10, 25, 50, 100] as const;
export const MAX_NAME = 40;
export const MAX_NICK = 20;
/** Shared at once by one wallet, and ever (unpublished ones included), so one wallet cannot flood the market. */
export const MAX_LIVE_PER_WALLET = 10;
export const MAX_EVER_PER_WALLET = 50;
/** Agent ids of shared agents, beside "made:" for your own. */
export const SHARED_PREFIX = 'shared:';

/** "0.5%", "1%", "0%". */
export const feeText = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
/** The fee on a trade of `usd`, in dollars. */
export const feeOn = (usd: number, bps: number) => (usd * bps) / 10_000;
export const shareLink = (origin: string, id: string) => `${origin.replace(/\/+$/, '')}/?agent=${encodeURIComponent(id)}`;
/** The shared agent a link points at (`?agent=<id>`), if any. */
export function linkedId(search: string): string | null {
  const v = new URLSearchParams(search).get('agent');
  return v && /^[a-z0-9]{6,16}$/.test(v) ? v : null;
}

/** Text someone else typed, made safe to show: no control characters, no surrounding space, at most `max` characters. */
export const plainText = (x: unknown, max: number) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, '').trim().slice(0, max) : '');

function cleanTerm(x: unknown): Term | null {
  const t = x as Partial<Term> | null;
  if (!t || typeof t !== 'object' || !(TERM_KINDS as string[]).includes(String(t.k))) return null;
  if (t.k === 'price') return { k: 'price' };
  const n = Number(t.n);
  return Number.isFinite(n) ? { k: t.k!, n } : null;
}
function cleanCond(x: unknown): Cond | null {
  const c = x as Partial<Cond> | null;
  if (!c || typeof c !== 'object' || (c.op !== 'above' && c.op !== 'below')) return null;
  const a = cleanTerm(c.a), b = cleanTerm(c.b);
  return a && b ? { a, op: c.op, b } : null;
}

/**
 * A rule from someone else, rebuilt from its parts: only known kinds of terms, finite numbers in their ranges,
 * a market from `markets`, at most MAX_CONDS conditions a side, and no problems() at all. Anything else is refused
 * (null), never repaired. It stays data: nothing in it is ever run as code.
 */
export function cleanSpec(x: unknown, markets: readonly string[], id: string, createdAt: number): MadeSpec | null {
  const s = x as Partial<MadeSpec> | null;
  if (!s || typeof s !== 'object' || !Array.isArray(s.buy) || !Array.isArray(s.sell)) return null;
  if (s.buy.length > MAX_CONDS || s.sell.length > MAX_CONDS) return null;
  if (typeof s.market !== 'string' || !markets.includes(s.market)) return null;
  const buy = s.buy.map(cleanCond), sell = s.sell.map(cleanCond);
  if (buy.some((c) => !c) || sell.some((c) => !c)) return null;
  const name = plainText(s.name, MAX_NAME);
  const interval = s.interval === undefined ? undefined : SPEC_INTERVALS.find((v) => v === s.interval);
  if (s.interval !== undefined && !interval) return null;
  const from = TEMPLATE_IDS.find((r) => r === s.from);
  const spec: MadeSpec = { id, name, market: s.market, buy: buy as Cond[], sell: sell as Cond[], createdAt, ...(from ? { from } : {}), ...(interval && interval !== '1d' ? { interval } : {}) };
  return problems(spec).length ? null : spec;
}

/** A fee the contract can pay: a whole number of basis points from 0 to MAX_FEE_BPS. */
export const validFee = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_FEE_BPS;
