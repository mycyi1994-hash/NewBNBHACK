// Moa agents for the marketplace: rule-based trading agents (one rule × one market), each scored by a
// long-only backtest on HashKey Global daily candles. Fees are charged on every entry and exit.
// Nothing here is invented: every number is computed from the candles the exchange returns.
import * as cex from './cex.ts';
import * as I from './indicators.ts';

export type RuleId = 'trend' | 'break' | 'rsi' | 'ema' | 'boll';
export type Style = 'trend' | 'revert';
export const RULES: { id: RuleId; style: Style; risk: 1 | 2 | 3 }[] = [
  { id: 'trend', style: 'trend', risk: 2 },
  { id: 'ema', style: 'trend', risk: 2 },
  { id: 'break', style: 'trend', risk: 3 },
  { id: 'rsi', style: 'revert', risk: 3 },
  { id: 'boll', style: 'revert', risk: 1 },
];
export const AGENT_MARKETS = ['BTCUSDT-PERPETUAL', 'ETHUSDT-PERPETUAL', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT'].map(cex.marketBySymbol);
const FEE = 0.001; // 0.1% per side

type Bar = cex.Candle;

/** Position per day (decided at that day's close). */
function positions(rule: RuleId, bars: Bar[]): boolean[] {
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

export interface Agent {
  id: string; rule: RuleId; style: Style; risk: 1 | 2 | 3; market: cex.Market;
  days: number; from: number; to: number;
  total: number; cagr: number; maxDd: number; sharpe: number; trades: number; winRate: number; inMarket: number;
  hold: number; equity: { time: number; value: number }[]; live: boolean;
}

/** Backtest one rule over the bars (warm-up of 60 days excluded). */
function score(rule: RuleId, market: cex.Market, bars: Bar[]): Agent | null {
  const start = 60;
  if (bars.length < start + 90) return null;
  const pos = positions(rule, bars);
  let eq = 1, peak = 1, maxDd = 0, trades = 0, wins = 0, entry = 0, inDays = 0;
  const rets: number[] = [];
  const equity: { time: number; value: number }[] = [{ time: bars[start].time, value: 1 }];
  for (let i = start; i < bars.length - 1; i++) {
    const was = i > start && pos[i - 1], now = pos[i];
    let day = 1;
    if (now && !was) { day *= 1 - FEE; trades++; entry = eq; }
    if (!now && was) { day *= 1 - FEE; if (eq * day > entry) wins++; }
    if (now) { day *= bars[i + 1].close / bars[i].close; inDays++; }
    eq *= day;
    rets.push(day - 1);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    equity.push({ time: bars[i + 1].time, value: eq });
  }
  const days = bars.length - 1 - start;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const closed = trades - (pos[bars.length - 2] ? 1 : 0);
  return {
    id: `${rule}-${market.symbol}`, rule, style: RULES.find((r) => r.id === rule)!.style, risk: RULES.find((r) => r.id === rule)!.risk, market,
    days, from: bars[start].time, to: bars[bars.length - 1].time,
    total: eq - 1, cagr: Math.pow(eq, 365 / days) - 1, maxDd, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    trades, winRate: closed > 0 ? wins / closed : 0, inMarket: inDays / days,
    hold: bars[bars.length - 1].close / bars[start].close - 1, equity, live: pos[bars.length - 1],
  };
}

let cache: Promise<Agent[]> | null = null;
/** All agents, scored on up to ~1000 daily candles per market. */
export function loadAgents(): Promise<Agent[]> {
  if (!cache) {
    cache = Promise.all(AGENT_MARKETS.map((m) => cex.klines(m, '1d', 1000).then((b) => ({ m, b })).catch(() => ({ m, b: [] as Bar[] }))))
      .then((sets) => sets.flatMap(({ m, b }) => RULES.map((r) => score(r.id, m, b)).filter((a): a is Agent => a !== null)))
      .catch((e: unknown) => { cache = null; throw e; });
  }
  return cache;
}
