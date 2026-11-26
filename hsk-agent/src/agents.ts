// Moa's agents: one fixed rule on one coin. One scoring module serves the agent market, the agents under
// the chart, Moa's cards and the server's recommend tool, so the same agent shows the same numbers everywhere.
//  - Position agents: long or flat, decided at each daily close on HashKey Global candles. The published
//    classics come first (12-month time-series momentum, the Turtle 20/10 breakout, the 200-day average timing
//    rule, the 50/200 golden cross), then standard indicator rules (MA50, EMA 20/50, RSI bounce, Bollinger).
//  - Collect agents (daily, smart, trend-filter and RSI-weighted DCA): a buy every day on Gate daily candles,
//    bigger on some days, smaller or skipped on others. Their returns are on the money put in so far.
// Every agent is scored over the same window, the last three years (or all there is for a younger coin), so
// returns and worst drops compare like for like. HashKey's own candles only go back to its listing dates
// (2024-05-29 for the BTC and ETH perpetuals), so the days before that are Gate spot daily candles joined in
// front; an agent whose window crosses the join says so (`seam`).
// Runnable: HSKSwap has a pool for the coin (HSK, ETH, BTC), so the agent can trade from the vault.
// Fees: 0.3% per swap for runnable agents (the HSKSwap pool fee), 0.1% per trade for signal-only agents
// (HashKey Global). Nothing here is invented: every number comes from the candles the exchanges return.
import * as cex from './cex.ts';
import { gateDailyRange } from './gate.ts';
import * as I from './indicators.ts';
import type { Asset } from './intent.ts';

export type PositionRule = 'tsmom' | 'break' | 'trend200' | 'golden' | 'trend' | 'ema' | 'rsi' | 'boll';
export type CollectRule = 'daily' | 'smart' | 'trendDca' | 'rsiDca';
export type RuleId = PositionRule | CollectRule;
export type Style = 'trend' | 'revert' | 'collect';
export type Risk = 1 | 2 | 3;

/**
 * Where a rule comes from, which is also the first key of every default order:
 *  1: a published strategy with a record in the industry or the literature
 *     (tsmom: Moskowitz, Ooi and Pedersen 2012, the core of managed-futures funds; break: the Turtle traders'
 *     System 1 entry and exit, Dennis and Eckhardt 1983; trend200: Faber's 10-month average timing rule, 2007,
 *     checked daily here; golden: the 50/200-day cross, the most widely followed long-term trend signal);
 *  2: a standard indicator rule traders know (MA50, EMA cross, Wilder's RSI, Bollinger bands, plain DCA);
 *  3: Moa's own variation of one of those.
 * The names and the caveats shown to the user are in i18n (agOrigin, agOriginNote).
 */
export type Tier = 1 | 2 | 3;
export const TIER: Record<RuleId, Tier> = {
  tsmom: 1, break: 1, trend200: 1, golden: 1,
  trend: 2, ema: 2, rsi: 2, boll: 2, daily: 2,
  smart: 3, trendDca: 3, rsiDca: 3,
};
/** Days of history a rule needs before its first decision (the slow ones need their long averages). */
const NEED: Partial<Record<RuleId, number>> = { tsmom: 365, trend200: 200, golden: 200 };

export const POSITION_RULES: { id: PositionRule; style: Style; risk: Risk }[] = [
  { id: 'tsmom', style: 'trend', risk: 2 },
  { id: 'break', style: 'trend', risk: 3 },
  { id: 'trend200', style: 'trend', risk: 2 },
  { id: 'golden', style: 'trend', risk: 2 },
  { id: 'trend', style: 'trend', risk: 2 },
  { id: 'ema', style: 'trend', risk: 2 },
  { id: 'rsi', style: 'revert', risk: 3 },
  { id: 'boll', style: 'revert', risk: 1 },
];
export const COLLECT_RULES: { id: CollectRule; risk: Risk }[] = [
  { id: 'daily', risk: 1 },
  { id: 'smart', risk: 1 },
  { id: 'trendDca', risk: 1 },
  { id: 'rsiDca', risk: 2 },
];
const COLLECT_IDS = new Set<string>(COLLECT_RULES.map((r) => r.id));

/** Coins with an HSKSwap pool: the only ones the vault can trade. */
export const RUNNABLE: Asset[] = ['HSK', 'ETH', 'BTC'];
export const isRunnable = (base: string): base is Asset => (RUNNABLE as string[]).includes(base);
/** Markets in the agent market. BTC and ETH follow their perpetuals; the rest are HashKey spot pairs. */
export const SIGNAL_MARKETS = ['BTCUSDT-PERPETUAL', 'ETHUSDT-PERPETUAL', 'HSKUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT']
  .map((s) => cex.MARKETS.find((m) => m.symbol === s))
  .filter((m): m is cex.Market => !!m);

export const FEE_HSKSWAP = 0.003;
export const FEE_HASHKEY = 0.001;
const DAY = 86_400;
const WARMUP = 60;          // days of indicator warm-up before the first decision
export const WINDOW = 1095; // every agent is scored over the last three years
const MIN_DAYS = 200;       // a coin with less than this to score an agent on does not get that agent
const DEPTH = 1900;         // days of history wanted: three years, a year of look-back, and room for "all history"
const BASE_USD = 10;        // collect backtests buy $10 × the day's multiplier

export interface Agent {
  id: string;
  kind: 'position' | 'collect';
  rule: RuleId;
  style: Style;
  risk: Risk;
  tier: Tier;
  base: string;
  runnable: boolean;
  source: 'hashkey' | 'gate';
  /** HashKey market the signal reads (position agents). */
  market?: cex.Market;
  fee: number;
  days: number; from: number; to: number;
  /** Position: strategy return. Collect: value ÷ money put in, minus 1. */
  total: number;
  /** Buying once at the start of the window and holding. */
  hold: number;
  /** Worst peak-to-trough drop of the equity curve, 0..1. */
  maxDd: number;
  sharpe: number;
  /** Position: entries. Collect: buys. */
  trades: number;
  inMarket: number;
  equity: { time: number; value: number }[];
  /** Buying once at the start and holding, on the same days as `equity` (the line the agent is compared with). */
  bench: { time: number; value: number }[];
  /** What the backtest did and when: every entry and exit (position), every buy with its size (collect). */
  marks: Mark[];
  /** Position: holding right now. Collect: today is a buying day. */
  live: boolean;
  /** Collect: today's buy as a multiple of the base amount (0 = skip). Position: 1 holding, 0 flat. */
  mult: number;
  /** Last close of the candles the agent reads. */
  price: number;
  /** Set when the window starts before the exchange listed the market: days before this time are Gate spot candles. */
  seam?: number;
}

/** One action of the backtest, at the close of the day `time` opens. */
export interface Mark {
  time: number;
  side: 'buy' | 'sell';
  price: number;
  /** Collect: the buy as a multiple of the base amount. */
  mult?: number;
  /** Position exits: return of that round trip after fees. */
  ret?: number;
}

/* ---------- candles, cached for 10 minutes so live signals refresh ---------- */

type Bar = cex.Candle;
const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; p: Promise<Bar[]> }>();
function cached(key: string, load: () => Promise<Bar[]>): Promise<Bar[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = load();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => { if (cache.get(key)?.p === p) cache.delete(key); });
  return p;
}
/** Where each HashKey market's own candles begin, when older Gate days were joined in front of them. */
const seams = new Map<string, number>();
/**
 * Daily candles for a HashKey market, with the days before its listing taken from Gate spot. If Gate cannot be
 * reached the HashKey candles are used alone (shorter history, never invented days).
 */
export const dailyHistory = (m: cex.Market) => cached(`hk:${m.symbol}`, async () => {
  const own = await cex.klines(m, '1d', 1000);
  if (!own.length) return own;
  const from = own[own.length - 1].time - DEPTH * DAY;
  if (own[0].time <= from) return own;
  // Prices only: another exchange's volume says nothing about this market, so the joined days carry none.
  const older = (await gateDailyRange(m.base, from, own[0].time - DAY).catch(() => [])).filter((b) => b.time < own[0].time).map((b) => ({ ...b, volume: 0 }));
  if (older.length) seams.set(m.symbol, own[0].time);
  return [...older, ...own];
});
const hashkeyDaily = dailyHistory;
/** Gate daily candles for a coin with an HSKSwap pool (the collect agents and the HSKSwap chart). */
export const collectHistory = (a: Asset) => cached(`gate:${a}`, () => { const now = Math.floor(Date.now() / 1000); return gateDailyRange(a, now - DEPTH * DAY, now + DAY); });
const gateDaily = collectHistory;

/* ---------- position agents ---------- */

/** Position per day (decided at that day's close). */
export function positions(rule: PositionRule, bars: Bar[]): boolean[] {
  const c = bars.map((b) => b.close);
  const pos: boolean[] = [];
  let on = false;
  if (rule === 'tsmom') return c.map((x, i) => i >= 365 && x > c[i - 365]);
  if (rule === 'trend200') { const ma = I.sma(c, 200); return c.map((x, i) => Number.isFinite(ma[i]) && x > ma[i]); }
  if (rule === 'golden') { const f = I.sma(c, 50), s = I.sma(c, 200); return c.map((_, i) => Number.isFinite(s[i]) && f[i] > s[i]); }
  if (rule === 'trend') { const ma = I.sma(c, 50); return c.map((x, i) => Number.isFinite(ma[i]) && x > ma[i]); }
  if (rule === 'ema') { const f = I.ema(c, 20), s = I.ema(c, 50); return c.map((_, i) => Number.isFinite(s[i]) && f[i] > s[i]); }
  if (rule === 'rsi') {
    const r = I.rsi(c);
    for (let i = 0; i < c.length; i++) { if (!on && r[i] < 30) on = true; else if (on && r[i] > 55) on = false; pos.push(on); }
    return pos;
  }
  if (rule === 'boll') {
    const b = I.boll(c);
    for (let i = 0; i < c.length; i++) { if (!on && c[i] < b.lo[i]) on = true; else if (on && c[i] > b.mid[i]) on = false; pos.push(on); }
    return pos;
  }
  // breakout: 20-day high in, 10-day low out
  for (let i = 0; i < bars.length; i++) {
    if (i < 21) { pos.push(false); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - 20; j < i; j++) hi = Math.max(hi, bars[j].high);
    for (let j = i - 10; j < i; j++) lo = Math.min(lo, bars[j].low);
    if (!on && bars[i].close > hi) on = true; else if (on && bars[i].close < lo) on = false;
    pos.push(on);
  }
  return pos;
}

function stats(rets: number[]) {
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
}

/**
 * Long-only backtest over the window (the last three years by default, any number of days, or `Infinity` for
 * all the history there is). Fees on every entry and exit. A younger coin is scored over what it has after the
 * rule's warm-up; with too little left the agent is not offered at all.
 */
export function scorePosition(rule: PositionRule, market: cex.Market, bars: Bar[], window = WINDOW): Agent | null {
  const need = NEED[rule] ?? WARMUP;
  const start = Math.max(need, bars.length - 1 - window);
  if (bars.length - 1 - start < Math.min(MIN_DAYS, window)) return null;
  const def = POSITION_RULES.find((r) => r.id === rule)!;
  const runnable = isRunnable(market.base);
  const fee = runnable ? FEE_HSKSWAP : FEE_HASHKEY;
  const pos = positions(rule, bars);
  let eq = 1, peak = 1, maxDd = 0, trades = 0, inDays = 0;
  const rets: number[] = [];
  const equity: { time: number; value: number }[] = [{ time: bars[start].time, value: 1 }];
  const bench: { time: number; value: number }[] = [{ time: bars[start].time, value: 1 }];
  const marks: Mark[] = [];
  let entry = 0;
  for (let i = start; i < bars.length - 1; i++) {
    const was = i > start && pos[i - 1], now = pos[i];
    let day = 1;
    if (now && !was) { day *= 1 - fee; trades++; entry = bars[i].close; marks.push({ time: bars[i].time, side: 'buy', price: entry }); }
    if (!now && was) { day *= 1 - fee; marks.push({ time: bars[i].time, side: 'sell', price: bars[i].close, ret: (bars[i].close / entry) * (1 - fee) ** 2 - 1 }); }
    if (now) { day *= bars[i + 1].close / bars[i].close; inDays++; }
    eq *= day;
    rets.push(day - 1);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    equity.push({ time: bars[i + 1].time, value: eq });
    bench.push({ time: bars[i + 1].time, value: bars[i + 1].close / bars[start].close });
  }
  const days = bars.length - 1 - start;
  const live = pos[bars.length - 1];
  return {
    id: `${rule}-${market.symbol}`, kind: 'position', rule, style: def.style, risk: def.risk, tier: TIER[rule], base: market.base,
    runnable, source: 'hashkey', market, fee,
    days, from: bars[start].time, to: bars[bars.length - 1].time,
    total: eq - 1, hold: bars[bars.length - 1].close / bars[start].close - 1, maxDd, sharpe: stats(rets),
    trades, inMarket: inDays / days, equity, bench, marks, live, mult: live ? 1 : 0, price: bars[bars.length - 1].close,
    seam: (seams.get(market.symbol) ?? 0) > bars[start].time ? seams.get(market.symbol) : undefined,
  };
}

/* ---------- collect agents ---------- */

/** Today's buy as a multiple of the base amount, from the indicators at index k and the price. */
function collectMult(rule: CollectRule, price: number, ma20: number, ma50: number, rsi: number): number {
  switch (rule) {
    case 'daily': return 1;
    case 'smart': return Math.min(2, Math.max(0.5, ma20 / price));
    case 'trendDca': return price > ma50 ? 1 : 0;
    case 'rsiDca': return rsi < 35 ? 2 : rsi > 65 ? 0.5 : 1;
  }
}

/** A buy every day over the window; decisions use yesterday's indicators so the test never peeks. */
export function scoreCollect(rule: CollectRule, asset: Asset, bars: Bar[], window = WINDOW): Agent | null {
  if (bars.length < WARMUP + 90) return null;
  const def = COLLECT_RULES.find((r) => r.id === rule)!;
  const fee = FEE_HSKSWAP;
  const c = bars.map((b) => b.close);
  const ma20 = I.sma(c, 20), ma50 = I.sma(c, 50), r = I.rsi(c);
  const start = Math.max(WARMUP, c.length - window);
  let qty = 0, put = 0, buys = 0, peak = 1, maxDd = 0, prev = 1;
  const rets: number[] = [];
  const equity: { time: number; value: number }[] = [];
  const bench: { time: number; value: number }[] = [];
  const marks: Mark[] = [];
  for (let i = start; i < c.length; i++) {
    const m = collectMult(rule, c[i], ma20[i - 1], ma50[i - 1], r[i - 1]);
    if (m > 0) { const usd = BASE_USD * m; qty += (usd * (1 - fee)) / c[i]; put += usd; buys++; marks.push({ time: bars[i].time, side: 'buy', price: c[i], mult: Math.round(m * 100) / 100 }); }
    const e = put > 0 ? (qty * c[i]) / put : 1;
    if (put > 0 && equity.length) rets.push(e / prev - 1);
    prev = e;
    peak = Math.max(peak, e);
    maxDd = Math.max(maxDd, 1 - e / peak);
    equity.push({ time: bars[i].time, value: e });
    bench.push({ time: bars[i].time, value: c[i] / c[start] });
  }
  const last = c.length - 1;
  const mult = Math.round(collectMult(rule, c[last], ma20[last], ma50[last], r[last]) * 100) / 100;
  const days = c.length - start;
  return {
    id: `${rule}-${asset}`, kind: 'collect', rule, style: 'collect', risk: def.risk, tier: TIER[rule], base: asset,
    runnable: true, source: 'gate', fee,
    days, from: bars[start].time, to: bars[last].time,
    total: prev - 1, hold: c[last] / c[start] - 1, maxDd, sharpe: stats(rets),
    trades: buys, inMarket: buys / days, equity, bench, marks, live: mult > 0, mult, price: c[last],
  };
}

/* ---------- loading ---------- */

/** The same agent over another window (days, or `Infinity` for everything after its warm-up), for a closer look at one agent. */
export async function rescore(a: Agent, window: number): Promise<Agent | null> {
  if (a.kind === 'collect') return isRunnable(a.base) ? scoreCollect(a.rule as CollectRule, a.base, await gateDaily(a.base), window) : null;
  return a.market ? scorePosition(a.rule as PositionRule, a.market, await hashkeyDaily(a.market), window) : null;
}

/** An agent that never traded in the window has no worst drop to judge, so it does not outrank one that did. */
export const idle = (a: Agent) => a.trades === 0;
/**
 * The default order everywhere: published classics first, then the smaller worst drop, then the better return.
 * Within a group, agents that did not trade at all in the window come last.
 */
export const byMerit = (a: Agent, b: Agent) => a.tier - b.tier || Number(idle(a)) - Number(idle(b)) || a.maxDd - b.maxDd || b.total - a.total || a.id.localeCompare(b.id);

/** The position agents for any HashKey market (the chart's market may not be in the listing). */
export async function positionAgents(m: cex.Market): Promise<Agent[]> {
  const bars = await hashkeyDaily(m);
  return POSITION_RULES.map((r) => scorePosition(r.id, m, bars)).filter((a): a is Agent => a !== null);
}

/** The four collect agents for a coin with an HSKSwap pool. */
export async function collectAgents(a: Asset): Promise<Agent[]> {
  const bars = await gateDaily(a);
  return COLLECT_RULES.map((r) => scoreCollect(r.id, a, bars)).filter((x): x is Agent => x !== null);
}

/** Every agent in the market. A market that fails to load is left out rather than filled in. */
export async function loadAgents(): Promise<Agent[]> {
  const sets = await Promise.all([
    ...SIGNAL_MARKETS.map((m) => positionAgents(m).catch(() => [] as Agent[])),
    ...RUNNABLE.map((a) => collectAgents(a).catch(() => [] as Agent[])),
  ]);
  const all = sets.flat();
  if (!all.length) throw new Error('No candles loaded from HashKey Global or Gate.');
  return all;
}

/** Any agent by id: `${rule}-${HashKey symbol}` for position agents, `${rule}-${coin}` for collect agents. */
export async function agentById(id: string): Promise<Agent | null> {
  const cut = id.indexOf('-');
  if (cut < 0) return null;
  const rule = id.slice(0, cut), rest = id.slice(cut + 1);
  if (COLLECT_IDS.has(rule)) {
    if (!isRunnable(rest)) return null;
    return (await collectAgents(rest)).find((a) => a.id === id) ?? null;
  }
  const m = cex.MARKETS.find((x) => x.symbol === rest);
  if (!m) return null;
  return (await positionAgents(m)).find((a) => a.id === id) ?? null;
}
