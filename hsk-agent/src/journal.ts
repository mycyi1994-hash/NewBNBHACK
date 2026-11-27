// The decision journal: every order an agent asks for (in the app) or sends (on the server) carries the inputs it was
// decided on, so anyone can check later why it traded. The inputs are written as one canonical JSON text (keys
// sorted, numbers to 10 significant digits), hashed with keccak256, and the hash goes on chain in the vault trade's
// note. "Check" recomputes the hash from the inputs the app kept: equal means these are the inputs that were hashed.
// Pure: no clock, no storage.
import { keccak256, stringToBytes, type Hex } from 'viem';

/** What the rule saw on the candle it decided on. */
export interface Decision {
  /** The agent and its rule (e.g. "volTarget-ETHUSDT-PERPETUAL", "volTarget"), the market and candle length it reads. */
  agentId: string;
  rule: string;
  market: string;
  interval: string;
  /** The candle the decision closed on (open time, seconds) and its close. */
  candle: number;
  close: number;
  /** The values the rule compared at that candle: its lines (averages, highs and lows, bands), RSI or return, volatility. */
  values: Record<string, number>;
  /** What the rule concluded: in or out, or the share of the budget it wants (with its band). */
  out: { live?: boolean; target?: number; band?: number; mult?: number };
}
export interface JournalEntry {
  v: 1;
  decision: Decision;
  /** The order this decision produced and what the agent held when it decided. */
  order: { side: 'buy' | 'sell'; usd?: number; qty?: number; why: string };
  held: { qty: number; budgetUsd: number; price?: number };
  /** When it was decided (ms). */
  at: number;
}
export interface Journal { hash: Hex; entry: JournalEntry }

const num = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(10)) : null);
/** The one text that is hashed: keys sorted at every level, numbers rounded to 10 significant digits, nothing undefined. */
export function canonical(x: unknown): string {
  if (x === null || x === undefined) return 'null';
  if (typeof x === 'number') return JSON.stringify(num(x));
  if (typeof x === 'string' || typeof x === 'boolean') return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export const journalHash = (e: JournalEntry): Hex => keccak256(stringToBytes(canonical(e)));
export function makeJournal(entry: JournalEntry): Journal { return { hash: journalHash(entry), entry }; }
/** Recompute and compare: true when these inputs are exactly the ones that were hashed. */
export const verifyJournal = (j: Journal): boolean => journalHash(j.entry) === j.hash.toLowerCase();
/** The on-chain note: the full hash first, so the vault's 120-character note never cuts it, then a short reason. */
export const noteWithHash = (hash: string, reason: string, max = 120) => `${hash} ${reason}`.slice(0, max);
