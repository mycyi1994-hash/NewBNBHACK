// Moa's agents: one fixed rule on one coin. One scoring module serves the agent market, the agents under
// the chart, Moa's cards and the server's recommend tool, so the same agent shows the same numbers everywhere.
//  - Position agents (trend, EMA cross, breakout, RSI bounce, Bollinger): long or flat, decided at each daily
//    close on HashKey Global candles.
//  - Collect agents (daily, smart, trend-filter and RSI-weighted DCA): a buy every day on Gate daily candles,
//    bigger on some days, smaller or skipped on others. Their returns are on the money put in so far.
// Every agent is scored over the same last 365 days, so returns and worst drops compare like for like.
// Runnable: HSKSwap has a pool for the coin (HSK, ETH, BTC), so the agent can trade from the vault.
// Fees: 0.3% per swap for runnable agents (the HSKSwap pool fee), 0.1% per trade for signal-only agents
// (HashKey Global). Nothing here is invented: every number comes from the candles the exchanges return.
import * as cex from './cex.ts';
import { gateCandles } from './gate.ts';
import * as I from './indicators.ts';
import type { Asset } from './intent.ts';

export type PositionRule = 'trend' | 'ema' | 'break' | 'rsi' | 'boll';
export type CollectRule = 'daily' | 'smart' | 'trendDca' | 'rsiDca';
export type RuleId = PositionRule | CollectRule;
export type Style = 'trend' | 'revert' | 'collect';
export type Risk = 1 | 2 | 3;

export const POSITION_RULES: { id: PositionRule; style: Style; risk: Risk }[] = [
  { id: 'trend', style: 'trend', risk: 2 },
  { id: 'ema', style: 'trend', risk: 2 },
  { id: 'break', style: 'trend', risk: 3 },
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
const WARMUP = 60;          // days of indicator warm-up before the first decision
const WINDOW = 365;         // every agent is scored over the last 365 days
const BASE_USD = 10;        // collect backtests buy $10 × the day's multiplier

export interface Agent {
  id: string;
  kind: 'position' | 'collect';
  rule: RuleId;
  style: Style;
  risk: Risk;
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
  /** Position: holding right now. Collect: today is a buying day. */
  live: boolean;
  /** Collect: today's buy as a multiple of the base amount (0 = skip). Position: 1 holding, 0 flat. */
  mult: number;
  /** Last close of the candles the agent reads. */
  price: number;
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
const hashkeyDaily = (m: cex.Market) => cached(`hk:${m.symbol}`, () => cex.klines(m, '1d', WARMUP + WINDOW + 20));
const gateDaily = (a: Asset) => cached(`gate:${a}`, () => gateCandles(a, '1d', WARMUP + WINDOW + 20));

/* ---------- position agents ---------- */

/** Position per day (decided at that day's close). */
export function positions(rule: PositionRule, bars: Bar[]): boolean[] {
  const c = bars.map((b) => b.close);
  const pos: boolean[] = [];
  let on = false;
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

/** Long-only backtest over the window. Fees on every entry and exit. */
export function scorePosition(rule: PositionRule, market: cex.Market, bars: Bar[]): Agent | null {
  if (bars.length < WARMUP + 90) return null;
  const start = Math.max(WARMUP, bars.length - 1 - WINDOW);
  const def = POSITION_RULES.find((r) => r.id === rule)!;
  const runnable = isRunnable(market.base);
  const fee = runnable ? FEE_HSKSWAP : FEE_HASHKEY;
  const pos = positions(rule, bars);
  let eq = 1, peak = 1, maxDd = 0, trades = 0, inDays = 0;
  const rets: number[] = [];
  const equity: { time: number; value: number }[] = [{ time: bars[start].time, value: 1 }];
  for (let i = start; i < bars.length - 1; i++) {
    const was = i > start && pos[i - 1], now = pos[i];
    let day = 1;
    if (now && !was) { day *= 1 - fee; trades++; }
    if (!now && was) day *= 1 - fee;
    if (now) { day *= bars[i + 1].close / bars[i].close; inDays++; }
    eq *= day;
    rets.push(day - 1);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    equity.push({ time: bars[i + 1].time, value: eq });
  }
  const days = bars.length - 1 - start;
  const live = pos[bars.length - 1];
  return {
    id: `${rule}-${market.symbol}`, kind: 'position', rule, style: def.style, risk: def.risk, base: market.base,
    runnable, source: 'hashkey', market, fee,
    days, from: bars[start].time, to: bars[bars.length - 1].time,
    total: eq - 1, hold: bars[bars.length - 1].close / bars[start].close - 1, maxDd, sharpe: stats(rets),
    trades, inMarket: inDays / days, equity, live, mult: live ? 1 : 0, price: bars[bars.length - 1].close,
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
export function scoreCollect(rule: CollectRule, asset: Asset, bars: Bar[]): Agent | null {
  if (bars.length < WARMUP + 90) return null;
  const def = COLLECT_RULES.find((r) => r.id === rule)!;
  const fee = FEE_HSKSWAP;
  const c = bars.map((b) => b.close);
  const ma20 = I.sma(c, 20), ma50 = I.sma(c, 50), r = I.rsi(c);
  const start = Math.max(WARMUP, c.length - WINDOW);
  let qty = 0, put = 0, buys = 0, peak = 1, maxDd = 0, prev = 1;
  const rets: number[] = [];
  const equity: { time: number; value: number }[] = [];
  for (let i = start; i < c.length; i++) {
    const m = collectMult(rule, c[i], ma20[i - 1], ma50[i - 1], r[i - 1]);
    if (m > 0) { const usd = BASE_USD * m; qty += (usd * (1 - fee)) / c[i]; put += usd; buys++; }
    const e = put > 0 ? (qty * c[i]) / put : 1;
    if (put > 0 && equity.length) rets.push(e / prev - 1);
    prev = e;
    peak = Math.max(peak, e);
    maxDd = Math.max(maxDd, 1 - e / peak);
    equity.push({ time: bars[i].time, value: e });
  }
  const last = c.length - 1;
  const mult = Math.round(collectMult(rule, c[last], ma20[last], ma50[last], r[last]) * 100) / 100;
  const days = c.length - start;
  return {
    id: `${rule}-${asset}`, kind: 'collect', rule, style: 'collect', risk: def.risk, base: asset,
    runnable: true, source: 'gate', fee,
    days, from: bars[start].time, to: bars[last].time,
    total: prev - 1, hold: c[last] / c[start] - 1, maxDd, sharpe: stats(rets),
    trades: buys, inMarket: buys / days, equity, live: mult > 0, mult, price: c[last],
  };
}

/* ---------- loading ---------- */

/** The five position agents for any HashKey market (the chart's market may not be in the listing). */
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
