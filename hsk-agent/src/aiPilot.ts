// Moa AI: the one agent whose share of its budget is decided by an AI model instead of a fixed rule.
// The server asks the model once per coin when each 4-hour candle closes, with a snapshot of numbers that this code
// builds itself (no text from outside goes in), and every vault that hired it follows that one shared target.
// Code, not the model, keeps the limits: the target is clamped to 0..1 and rounded to 5%, moves at most 25 points a
// decision, a change under 15 points is no change, at most one decision per interval, and anything wrong (old or
// missing data, a failed or late call, an answer that does not fit) keeps the previous target and records why.
// This file is pure (no clock, no network, no storage) apart from where the decisions are read from: the server's
// own store in the server, its public API in the browser.
import { keccak256, stringToBytes, type Hex } from 'viem';
import type { Agent, Mark } from './agents.ts';
import type { Asset } from './intent.ts';
import type { Decision } from './journal.ts';
import { canonical } from './journal.ts';
import type * as cex from './cex.ts';

export const AI_RULE = 'aiPilot' as const;
export const AI_INTERVAL = '4h' as const;
export const AI_EVERY_MS = 4 * 3_600_000;
/** A decision less than this after the last one waits (the interval, less a little for the runner's ticks). */
export const COOLDOWN_MS = AI_EVERY_MS - 10 * 60_000;
/** The last closed 4-hour candle must be this recent, or the data is too old to decide on. */
export const STALE_MS = AI_EVERY_MS + 30 * 60_000;
export const ROUND = 0.05;
export const STEP = 0.25;
export const BAND = 0.15;
/** How long one model call may take before it counts as failed. */
export const CALL_MS = 90_000;
export const COINS: Asset[] = ['BTC', 'ETH', 'HSK'];
/** The HashKey Global market whose candles each coin's snapshot reads (the same ones the coin's other agents read). */
export const AI_MARKET: Record<Asset, string> = { BTC: 'BTCUSDT-PERPETUAL', ETH: 'ETHUSDT-PERPETUAL', HSK: 'HSKUSDT' };
/** What the pool trades cost in the paper result: the HSKSwap fee on each change of share (price impact is not counted). */
export const PAPER_FEE = 0.003;

/** Every number the snapshot can carry. The model may only name these as its signals. */
export const SIGNAL_KEYS = [
  'price', 'ret1d', 'ret7d', 'ret30d', 'ret90d', 'ma20', 'ma50', 'ma200', 'vsMa20', 'vsMa50', 'vsMa200', 'vol20',
  'poolPrice', 'poolGap', 'poolNet100', 'poolRoundTrip', 'poolDepth2pct',
  'flowNet24h', 'flowBuy24h', 'flowSell24h', 'flowSwaps24h', 'flowNet7d', 'prevTarget',
] as const;
export type SignalKey = typeof SIGNAL_KEYS[number];
/** Keys whose values are shares (0.012 = 1.2%); the model sees them as percents. */
const PCT_KEYS = new Set<SignalKey>(['ret1d', 'ret7d', 'ret30d', 'ret90d', 'vsMa20', 'vsMa50', 'vsMa200', 'vol20', 'poolGap', 'poolNet100', 'poolRoundTrip', 'prevTarget']);

/** What the model is shown: the coin, the candle it decides on, and numbers. A value that could not be read has no key. */
export type AiSnapshot = { asset: Asset; candle: number } & Partial<Record<SignalKey, number>>;

/** Why a decision kept the previous target instead of taking the model's. */
export type HeldWhy = 'off' | 'stale' | 'noData' | 'timeout' | 'callFailed' | 'refusal' | 'invalid';
export interface AiDecision {
  /** When it was decided (ms) and the 4-hour candle it decided on (open time, seconds). */
  at: number; candle: number; asset: Asset;
  /** The model that answered (the server's model, or the one it fell back to); null when no call was made. */
  model: string | null;
  /** The share of the budget in force after this decision. A held decision repeats the previous one. */
  target: number;
  /** The share the model asked for, before the limits; absent when it gave none. */
  proposed?: number;
  prev: number | null;
  /** The model's reason in plain words (English and Korean), or, when held, why in the app's words. */
  reason: string; reasonKo: string;
  signals: SignalKey[];
  held?: HeldWhy;
  /** Which limit changed the model's number. */
  guard?: { clamped?: true; stepped?: true; banded?: true };
  /** The price the snapshot read (the candle's close), for the paper result. */
  price?: number;
  snapshot?: AiSnapshot;
  /** keccak256 of everything above (see decisionHash). */
  hash: Hex;
}
export type AiState = 'on' | 'noKey' | 'off';
/** What the server says about one coin's AI agent: is it deciding, and what it decided. */
export interface AiFeed {
  asset: Asset; state: AiState; every: number; model: string | null;
  /** Newest last. The browser gets the last ones; `paper` is computed over all of them. */
  decisions: AiDecision[];
  paper: Paper | null;
  /** How many decisions there are in all. */
  count: number;
}

/* ---------- the limits ---------- */

const round = (x: number) => Math.round(x / ROUND) * ROUND;
const fix = (x: number) => Number(x.toFixed(2));
/**
 * The model's number through the limits, in order: clamp to 0..1 and round to 5%; move at most STEP from the target
 * in force; a move under BAND is no move. An agent that has not decided yet starts from nothing held (0).
 */
export function guard(prev: number | null, proposed: number): { target: number; guard: NonNullable<AiDecision['guard']> } {
  const g: NonNullable<AiDecision['guard']> = {};
  const from = prev ?? 0;
  let t = Math.min(1, Math.max(0, proposed));
  if (t !== proposed) g.clamped = true;
  t = fix(round(t));
  const d = t - from;
  if (Math.abs(d) > STEP + 1e-9) { t = fix(from + Math.sign(d) * STEP); g.stepped = true; }
  if (Math.abs(t - from) < BAND - 1e-9 && t !== from) { t = from; g.banded = true; }
  return { target: fix(t), guard: g };
}

/** At most one decision per 4-hour candle, and never sooner than the cool-down after the last one. */
export function isDue(last: Pick<AiDecision, 'at' | 'candle'> | undefined, candle: number, now: number): boolean {
  if (!last) return true;
  return candle > last.candle && now - last.at >= COOLDOWN_MS;
}
/** The 4-hour candle that closed last, by the clock (open time, seconds). Candles start at 00:00, 04:00 … UTC. */
export const lastClosedCandle = (now: number) => Math.floor(now / AI_EVERY_MS) * (AI_EVERY_MS / 1000) - AI_EVERY_MS / 1000;

/* ---------- the snapshot ---------- */

type Bar = cex.Candle;
const DAY_S = 86_400;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
export interface SnapshotInput {
  asset: Asset; now: number;
  /** Closed daily candles, oldest first. */
  daily: Bar[];
  /** Closed 4-hour candles, oldest first. */
  h4: Bar[];
  /** The HSKSwap pool against the exchange (src/spread.ts): pool price, gap, net at $100, round trip; null when unread. */
  pool?: { price: number; gap: number; net100?: number; roundTrip?: number; depth2pct?: number } | null;
  /** The pool's on-chain flow (HSK only, src/onchain.ts). */
  flow?: { net24h: number; buy24h: number; sell24h: number; swaps24h: number; net7d: number } | null;
  prevTarget: number | null;
}
/**
 * The numbers the model decides on, all computed here: the last closed 4-hour close; returns over 1, 7, 30 and 90 days;
 * the 20, 50 and 200-day averages and where the price is against them; 20-day volatility (yearly); the pool against
 * the exchange and its depth within 2%; for HSK the pool's buy and sell flow; and the agent's target in force.
 * Not built (the decision is held) when the last 4-hour candle is older than STALE_MS or there are under 201 days.
 */
export function buildSnapshot(i: SnapshotInput): { ok: true; snap: AiSnapshot } | { ok: false; why: 'stale' | 'noData' } {
  const last4 = i.h4[i.h4.length - 1];
  if (!last4 || !i.daily.length) return { ok: false, why: 'noData' };
  const closeAt = (last4.time + AI_EVERY_MS / 1000) * 1000;
  if (i.now - closeAt > STALE_MS || closeAt > i.now + 60_000) return { ok: false, why: 'stale' };
  const price = last4.close;
  // Daily candles that closed by the time this 4-hour candle closed.
  const days = i.daily.filter((b) => (b.time + DAY_S) * 1000 <= closeAt);
  if (days.length < 201 || !(price > 0)) return { ok: false, why: 'noData' };
  const c = days.map((b) => b.close);
  const ago = (n: number) => { const t = closeAt / 1000 - n * DAY_S; const d = [...days].reverse().find((b) => b.time + DAY_S <= t); return d?.close; };
  const s: AiSnapshot = { asset: i.asset, candle: last4.time, price };
  const put = (k: SignalKey, v: number | undefined) => { if (v !== undefined && Number.isFinite(v)) s[k] = v; };
  for (const [k, n] of [['ret1d', 1], ['ret7d', 7], ['ret30d', 30], ['ret90d', 90]] as const) { const p = ago(n); put(k, p ? price / p - 1 : undefined); }
  for (const [k, v, n] of [['ma20', 'vsMa20', 20], ['ma50', 'vsMa50', 50], ['ma200', 'vsMa200', 200]] as const) { const m = mean(c.slice(-n)); put(k, m); put(v, price / m - 1); }
  const lr = c.slice(-21).map((x, j, xs) => (j ? Math.log(x / xs[j - 1]) : NaN)).slice(1);
  const mu = mean(lr);
  put('vol20', Math.sqrt(lr.reduce((acc, x) => acc + (x - mu) ** 2, 0) / (lr.length - 1)) * Math.sqrt(365));
  if (i.pool) { put('poolPrice', i.pool.price); put('poolGap', i.pool.gap); put('poolNet100', i.pool.net100); put('poolRoundTrip', i.pool.roundTrip); put('poolDepth2pct', i.pool.depth2pct); }
  if (i.flow) { put('flowNet24h', i.flow.net24h); put('flowBuy24h', i.flow.buy24h); put('flowSell24h', i.flow.sell24h); put('flowSwaps24h', i.flow.swaps24h); put('flowNet7d', i.flow.net7d); }
  put('prevTarget', i.prevTarget ?? undefined);
  return { ok: true, snap: s };
}

/** The snapshot as the model reads it: percents for shares, a few significant digits, the candle as a UTC time. */
export function forModel(s: AiSnapshot): Record<string, number | string> {
  const out: Record<string, number | string> = { asset: s.asset, candleClosedUtc: new Date((s.candle + AI_EVERY_MS / 1000) * 1000).toISOString() };
  for (const k of SIGNAL_KEYS) {
    const v = s[k];
    if (v === undefined) continue;
    out[PCT_KEYS.has(k) ? `${k}Pct` : k] = PCT_KEYS.has(k) ? Number((v * 100).toFixed(2)) : Number(v.toPrecision(6));
  }
  return out;
}

/* ---------- the model's answer ---------- */

/** The answer the model must give (structured output): a share, a short reason in English and Korean, the inputs it used. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'number', description: 'Share of the budget to hold in the coin for the next 4 hours, 0 to 1' },
    reason: { type: 'string', description: 'Why, in plain English words, at most 200 characters' },
    reason_ko: { type: 'string', description: 'The same reason in plain Korean, at most 200 characters' },
    signals: { type: 'array', items: { type: 'string', enum: [...SIGNAL_KEYS] }, description: 'The snapshot inputs the decision leaned on most (1 to 4)' },
  },
  required: ['target', 'reason', 'reason_ko', 'signals'],
  additionalProperties: false,
} as const;

/** Plain words only: no markup, links or control characters, one line, at most 200 characters. */
export function plain(x: string, max = 200): string {
  return x.replace(/[\u0000-\u001f\u007f<>{}[\]`*_#|\\]/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}
/** The model's output read strictly: a finite number, two non-empty reasons and known signal names, or why not. */
export function parseOutput(raw: unknown): { ok: true; target: number; reason: string; reasonKo: string; signals: SignalKey[] } | { ok: false; why: string } {
  let x = raw;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return { ok: false, why: 'not JSON' }; } }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, why: 'not an object' };
  const o = x as Record<string, unknown>;
  const target = typeof o.target === 'number' ? o.target : typeof o.target === 'string' && o.target.trim() !== '' ? Number(o.target) : NaN;
  if (!Number.isFinite(target)) return { ok: false, why: 'no target number' };
  if (typeof o.reason !== 'string' || typeof o.reason_ko !== 'string') return { ok: false, why: 'no reason' };
  const reason = plain(o.reason), reasonKo = plain(o.reason_ko);
  if (!reason || !reasonKo) return { ok: false, why: 'empty reason' };
  const known = new Set<string>(SIGNAL_KEYS);
  const signals = (Array.isArray(o.signals) ? o.signals : []).filter((s): s is SignalKey => typeof s === 'string' && known.has(s)).filter((s, j, xs) => xs.indexOf(s) === j).slice(0, 4);
  return { ok: true, target, reason, reasonKo, signals };
}

/** What the app says when a decision is held (the model's words are only ever its own reason). */
export const HELD_TEXT: Record<HeldWhy, [string, string]> = {
  off: ['The AI trader is switched off on this server: the target stays as it was.', '이 서버에서 AI 트레이더가 꺼져 있어요. 목표 비중은 그대로예요.'],
  stale: ['The latest candles were too old to decide on: the target stays as it was.', '최근 캔들이 너무 오래돼서 판단하지 않았어요. 목표 비중은 그대로예요.'],
  noData: ['The prices could not be read (or there is too little history): the target stays as it was.', '가격을 읽지 못했어요(또는 기록이 너무 짧아요). 목표 비중은 그대로예요.'],
  timeout: ['The AI did not answer in time: the target stays as it was.', 'AI가 제때 답하지 않았어요. 목표 비중은 그대로예요.'],
  callFailed: ['The AI could not be reached: the target stays as it was.', 'AI에 연결하지 못했어요. 목표 비중은 그대로예요.'],
  refusal: ['The AI declined to answer: the target stays as it was.', 'AI가 답하지 않았어요. 목표 비중은 그대로예요.'],
  invalid: ['The AI’s answer did not fit the required form: the target stays as it was.', 'AI의 답이 정해진 형식에 맞지 않았어요. 목표 비중은 그대로예요.'],
};

/** keccak256 of the decision's canonical text (journal.ts), everything but the hash itself. */
export function decisionHash(d: Omit<AiDecision, 'hash'>): Hex {
  return keccak256(stringToBytes(canonical(d)));
}
export const withHash = (d: Omit<AiDecision, 'hash'>): AiDecision => ({ ...d, hash: decisionHash(d) });
export const verifyDecision = (d: AiDecision) => { const { hash, ...rest } = d; return decisionHash(rest) === hash; };

/** A decision that keeps the target in force, with the app's reason. */
export function heldDecision(base: { at: number; candle: number; asset: Asset; prev: number | null; model: string | null; snapshot?: AiSnapshot; proposed?: number }, why: HeldWhy): AiDecision {
  const [en, ko] = HELD_TEXT[why];
  return withHash({ ...base, target: base.prev ?? 0, reason: en, reasonKo: ko, signals: [], held: why, ...(base.snapshot?.price ? { price: base.snapshot.price } : {}) });
}
/** A decision from the model's parsed answer, through the limits. */
export function madeDecision(base: { at: number; asset: Asset; prev: number | null; model: string; snapshot: AiSnapshot }, out: { target: number; reason: string; reasonKo: string; signals: SignalKey[] }): AiDecision {
  const g = guard(base.prev, out.target);
  return withHash({
    at: base.at, candle: base.snapshot.candle, asset: base.asset, model: base.model, target: g.target, proposed: out.target, prev: base.prev,
    reason: out.reason, reasonKo: out.reasonKo, signals: out.signals, ...(Object.keys(g.guard).length ? { guard: g.guard } : {}), price: base.snapshot.price, snapshot: base.snapshot,
  });
}

/* ---------- the paper result ---------- */

export interface Paper {
  /** From the first decision the model made to the last decision (ms). */
  since: number; to: number; days: number;
  /** Following the recorded targets at the recorded prices, with PAPER_FEE on each change; and just holding. */
  total: number; hold: number; maxDd: number; changes: number;
  equity: { time: number; value: number }[]; bench: { time: number; value: number }[];
}
/**
 * What following the recorded targets would have made, from the first decision the model made: between two decisions
 * the share in force rides the price move between their recorded prices. Paper only: no vault traded this, the fee is
 * the pool's 0.3% on each change, price impact is not counted. Null before the model's first decision.
 */
export function paperTrack(ds: AiDecision[]): Paper | null {
  const xs = ds.filter((d) => d.price !== undefined && d.price > 0);
  const first = xs.findIndex((d) => !d.held);
  if (first < 0) return null;
  const run = xs.slice(first);
  let eq = 1, peak = 1, maxDd = 0, w = 0, changes = 0;
  const p0 = run[0].price!;
  const equity: Paper['equity'] = [], bench: Paper['bench'] = [];
  for (let j = 0; j < run.length; j++) {
    const d = run[j];
    if (j > 0) eq *= 1 + w * (d.price! / run[j - 1].price! - 1);
    if (d.target !== w) { eq *= 1 - PAPER_FEE * Math.abs(d.target - w); w = d.target; changes++; }
    peak = Math.max(peak, eq); maxDd = Math.max(maxDd, 1 - eq / peak);
    equity.push({ time: Math.floor(d.at / 1000), value: eq });
    bench.push({ time: Math.floor(d.at / 1000), value: d.price! / p0 });
  }
  const since = run[0].at, to = run[run.length - 1].at;
  return { since, to, days: (to - since) / 86_400_000, total: eq - 1, hold: run[run.length - 1].price! / p0 - 1, maxDd, changes, equity, bench };
}

/* ---------- the agent ---------- */

/** The newest decision that set a price, and the newest decision overall. */
const lastPriced = (ds: AiDecision[]) => [...ds].reverse().find((d) => d.price !== undefined && d.price > 0);
/** The journal entry of the decision in force: its snapshot's numbers, the target, and the AI's model, reason and hash. */
export function journalDecision(f: AiFeed, d: AiDecision, price: number): Decision {
  const values: Record<string, number> = {};
  for (const k of SIGNAL_KEYS) { const v = d.snapshot?.[k]; if (v !== undefined) values[k] = v; }
  return {
    agentId: `${AI_RULE}-${f.asset}`, rule: AI_RULE, market: AI_MARKET[f.asset], interval: AI_INTERVAL, candle: d.candle, close: price, values,
    out: { target: d.target, band: BAND },
    ai: { model: d.model ?? '', reason: d.reason, reasonKo: d.reasonKo, signals: d.signals, hash: d.hash, at: d.at, ...(d.held ? { held: d.held } : {}) },
  };
}
/**
 * One coin's AI agent as a market agent, so it is hired, run and journaled like the others (a weight agent). It has no
 * backtest: its numbers are the paper result since its first decision (zero before). It trades only while the server's
 * AI is on and has decided at least once (`target` is set only then); otherwise nothing follows it.
 */
export function aiAgent(f: AiFeed): Agent {
  const last = f.decisions[f.decisions.length - 1];
  const priced = lastPriced(f.decisions);
  const p = f.paper;
  const on = f.state === 'on';
  const decided = f.decisions.some((d) => !d.held);
  const price = priced?.price ?? 0;
  const marks: Mark[] = (p ? f.decisions.filter((d) => !d.held && d.at >= p.since && d.prev !== d.target && d.price) : []).map((d) => ({ time: Math.floor(d.at / 1000), side: (d.target > (d.prev ?? 0) ? 'buy' : 'sell') as Mark['side'], price: d.price!, mult: d.target, resize: true as const }));
  const target = on && decided && last ? last.target : undefined;
  return {
    id: `${AI_RULE}-${f.asset}`, kind: 'position', rule: AI_RULE, style: 'trend', risk: 2, tier: 3, base: f.asset, runnable: on, source: 'hashkey',
    // No market: there are no candles to backtest it on, so nothing rescores or charts it as a rule.
    fee: PAPER_FEE,
    days: p ? Math.max(0, Math.round(p.days)) : 0, from: Math.floor((p?.since ?? Date.now()) / 1000), to: Math.floor((p?.to ?? Date.now()) / 1000),
    total: p?.total ?? 0, hold: p?.hold ?? 0, maxDd: p?.maxDd ?? 0, sharpe: 0, trades: p?.changes ?? 0, inMarket: 0,
    ...(target !== undefined ? { target, band: BAND } : {}),
    ...(last && target !== undefined && price > 0 ? { decision: journalDecision(f, last, price) } : {}),
    equity: p?.equity ?? [], bench: p?.bench ?? [], marks, live: (target ?? 0) > 0, mult: target ?? 0, price, interval: AI_INTERVAL,
    ai: { state: f.state, model: f.model, every: f.every, count: f.count, decisions: f.decisions, paper: p },
  };
}
export const isAi = (a: Pick<Agent, 'rule'>) => a.rule === AI_RULE;

/* ---------- where the decisions are read from ---------- */

let source: (asset: Asset) => Promise<AiFeed> = async (asset) => {
  const r = await fetch(`/api/ai/decisions?asset=${asset}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`AI decisions HTTP ${r.status}`);
  return (await r.json()) as AiFeed;
};
export const setAiSource = (f: typeof source) => { source = f; };
export const aiFeed = (asset: Asset) => source(asset);
export const aiAgentOf = async (asset: Asset) => aiAgent(await aiFeed(asset));
