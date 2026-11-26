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
import { specLines, specNeed, specPane, specPositions, type MadeSpec } from './spec.ts';
import { MADE_PREFIX, madeById, madeList } from './madeStore.ts';

export type PositionRule =
  | 'tsmom' | 'multiTrend' | 'dualMom' | 'trend200' | 'golden' | 'break' | 'turtle2' | 'donchian' | 'ma520' | 'triple'
  | 'macd' | 'ichimoku' | 'keltner' | 'psar' | 'adx' | 'aroon' | 'cryptoMom' | 'rsi2' | 'double7'
  | 'trend' | 'ema' | 'rsi' | 'boll';
export type CollectRule = 'daily' | 'smart' | 'trendDca' | 'rsiDca';
/** `made` is an agent someone built themselves (its rule is data: see spec.ts). */
export type RuleId = PositionRule | CollectRule | 'made';
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
  tsmom: 1, multiTrend: 1, dualMom: 1, trend200: 1, golden: 1, break: 1, turtle2: 1, donchian: 1, ma520: 1, triple: 1,
  macd: 1, ichimoku: 1, keltner: 1, psar: 1, adx: 1, aroon: 1, cryptoMom: 1, rsi2: 1, double7: 1, daily: 1,
  trend: 2, ema: 2, rsi: 2, boll: 2,
  smart: 3, trendDca: 3, rsiDca: 3, made: 3,
};
/**
 * What stands behind a rule, said plainly on every agent:
 *  paper: tested in a published paper; record: run with real money and published afterwards;
 *  book: published by its author and widely used, with no formal test of this exact rule;
 *  common: a widely followed signal with no single author; none: nothing published, only the backtest here.
 */
export type Proof = 'paper' | 'record' | 'book' | 'common' | 'none';
export const PROOF: Record<RuleId, Proof> = {
  tsmom: 'paper', multiTrend: 'paper', dualMom: 'paper', trend200: 'paper', cryptoMom: 'paper',
  break: 'record', turtle2: 'record',
  donchian: 'book', ma520: 'book', triple: 'book', macd: 'book', ichimoku: 'book', keltner: 'book', psar: 'book', adx: 'book', aroon: 'book', rsi2: 'book', double7: 'book', daily: 'book',
  golden: 'common',
  trend: 'none', ema: 'none', rsi: 'none', boll: 'none', smart: 'none', trendDca: 'none', rsiDca: 'none', made: 'none',
};
/** Days of history a rule needs before its first decision (the slow ones need their long averages). */
const NEED: Partial<Record<RuleId, number>> = { tsmom: 365, multiTrend: 365, dualMom: 365, trend200: 200, golden: 200, rsi2: 200, double7: 200, ichimoku: 90 };

export const POSITION_RULES: { id: PositionRule; style: Style; risk: Risk }[] = [
  { id: 'tsmom', style: 'trend', risk: 2 },
  { id: 'multiTrend', style: 'trend', risk: 2 },
  { id: 'dualMom', style: 'trend', risk: 2 },
  { id: 'trend200', style: 'trend', risk: 2 },
  { id: 'golden', style: 'trend', risk: 2 },
  { id: 'break', style: 'trend', risk: 3 },
  { id: 'turtle2', style: 'trend', risk: 2 },
  { id: 'donchian', style: 'trend', risk: 3 },
  { id: 'ma520', style: 'trend', risk: 3 },
  { id: 'triple', style: 'trend', risk: 3 },
  { id: 'macd', style: 'trend', risk: 3 },
  { id: 'ichimoku', style: 'trend', risk: 2 },
  { id: 'keltner', style: 'trend', risk: 3 },
  { id: 'psar', style: 'trend', risk: 3 },
  { id: 'adx', style: 'trend', risk: 3 },
  { id: 'aroon', style: 'trend', risk: 3 },
  { id: 'cryptoMom', style: 'trend', risk: 3 },
  { id: 'rsi2', style: 'revert', risk: 2 },
  { id: 'double7', style: 'revert', risk: 2 },
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
  /** A made agent's own rule. */
  made?: MadeSpec;
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

/* ----- the series the rules read (also drawn on the chart, so a buy or sell can be read off it) ----- */

const NANS = (n: number) => new Array<number>(n).fill(NaN);
/** Highest high / lowest low of the n days before each day (today not included). */
const prevHigh = (bars: Bar[], n: number) => bars.map((_, i) => { if (i < n) return NaN; let v = -Infinity; for (let j = i - n; j < i; j++) v = Math.max(v, bars[j].high); return v; });
const prevLow = (bars: Bar[], n: number) => bars.map((_, i) => { if (i < n) return NaN; let v = Infinity; for (let j = i - n; j < i; j++) v = Math.min(v, bars[j].low); return v; });
/** Midpoint of the n-day range ending today (Ichimoku's lines). */
const mid = (bars: Bar[], n: number) => bars.map((_, i) => { if (i < n - 1) return NaN; let h = -Infinity, l = Infinity; for (let j = i - n + 1; j <= i; j++) { h = Math.max(h, bars[j].high); l = Math.min(l, bars[j].low); } return (h + l) / 2; });
const shift = (xs: number[], by: number) => xs.map((_, i) => (i >= by ? xs[i - by] : NaN));
/** EMA of a series that starts with empty values. */
const emaFrom = (xs: number[], n: number) => { const at = xs.findIndex((v) => Number.isFinite(v)); if (at < 0) return NANS(xs.length); return [...NANS(at), ...I.ema(xs.slice(at), n)]; };
/** Wilder's average true range, one value per day. */
function atrSeries(bars: Bar[], n: number): number[] {
  const out = NANS(bars.length);
  let a = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (i <= n) { a += tr / n; if (i === n) out[i] = a; } else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}
/** Wilder's parabolic stop-and-reverse (step 0.02, maximum 0.20): the stop, and whether the trend is up. */
function psar(bars: Bar[]): { sar: number[]; up: boolean[] } {
  const n = bars.length, sar = NANS(n), up = new Array<boolean>(n).fill(false);
  if (n < 3) return { sar, up };
  let long = bars[1].close >= bars[0].close, af = 0.02;
  let ep = long ? Math.max(bars[0].high, bars[1].high) : Math.min(bars[0].low, bars[1].low);
  let s = long ? Math.min(bars[0].low, bars[1].low) : Math.max(bars[0].high, bars[1].high);
  sar[1] = s; up[1] = long;
  for (let i = 2; i < n; i++) {
    s += af * (ep - s);
    if (long) {
      s = Math.min(s, bars[i - 1].low, bars[i - 2].low);
      if (bars[i].low < s) { long = false; s = ep; ep = bars[i].low; af = 0.02; } else if (bars[i].high > ep) { ep = bars[i].high; af = Math.min(0.2, af + 0.02); }
    } else {
      s = Math.max(s, bars[i - 1].high, bars[i - 2].high);
      if (bars[i].high > s) { long = true; s = ep; ep = bars[i].high; af = 0.02; } else if (bars[i].low < ep) { ep = bars[i].low; af = Math.min(0.2, af + 0.02); }
    }
    sar[i] = s; up[i] = long;
  }
  return { sar, up };
}
/** Wilder's directional movement: +DI, −DI and ADX. */
function dmi(bars: Bar[], n = 14) {
  const len = bars.length, pdi = NANS(len), mdi = NANS(len), adx = NANS(len);
  let sp = 0, sm = 0, st = 0, a = 0, seen = 0;
  for (let i = 1; i < len; i++) {
    const upMove = bars[i].high - bars[i - 1].high, dnMove = bars[i - 1].low - bars[i].low;
    const p = upMove > dnMove && upMove > 0 ? upMove : 0, m = dnMove > upMove && dnMove > 0 ? dnMove : 0;
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (i <= n) { sp += p; sm += m; st += tr; if (i < n) continue; } else { sp += p - sp / n; sm += m - sm / n; st += tr - st / n; }
    pdi[i] = st ? (100 * sp) / st : 0; mdi[i] = st ? (100 * sm) / st : 0;
    const dx = pdi[i] + mdi[i] ? (100 * Math.abs(pdi[i] - mdi[i])) / (pdi[i] + mdi[i]) : 0;
    seen++;
    if (seen <= n) { a += dx / n; if (seen === n) adx[i] = a; } else { a = (a * (n - 1) + dx) / n; adx[i] = a; }
  }
  return { pdi, mdi, adx };
}
/** Aroon up and down: how recently the n-day high and low were made (100 = today). */
function aroon(bars: Bar[], n = 25) {
  const up = NANS(bars.length), down = NANS(bars.length);
  for (let i = n; i < bars.length; i++) {
    let hi = i - n, lo = i - n;
    for (let j = i - n; j <= i; j++) { if (bars[j].high >= bars[hi].high) hi = j; if (bars[j].low <= bars[lo].low) lo = j; }
    up[i] = (100 * (n - (i - hi))) / n; down[i] = (100 * (n - (i - lo))) / n;
  }
  return { up, down };
}
const cloud = (bars: Bar[]) => { const t = mid(bars, 9), k = mid(bars, 26); return { a: shift(t.map((v, i) => (v + k[i]) / 2), 26), b: shift(mid(bars, 52), 26) }; };
const keltner = (bars: Bar[]) => { const e = I.ema(bars.map((b) => b.close), 20), a = atrSeries(bars, 10); return { mid: e, up: e.map((v, i) => v + 2 * a[i]) }; };
/** In above `enter`, out below `exit`, holding in between. */
const latch = (n: number, enter: (i: number) => boolean, exit: (i: number) => boolean) => { const pos: boolean[] = []; let on = false; for (let i = 0; i < n; i++) { if (!on && enter(i)) on = true; else if (on && exit(i)) on = false; pos.push(on); } return pos; };

/**
 * Position per day (decided at that day's close). `ref` is the other major coin's candles, used only by the
 * dual-momentum rule (which holds this coin only while it is also the stronger of the two).
 */
export function positions(rule: PositionRule, bars: Bar[], ref?: Bar[]): boolean[] {
  const c = bars.map((b) => b.close), n = c.length;
  const ok = Number.isFinite;
  const ret = (i: number, d: number) => (i >= d ? c[i] / c[i - d] - 1 : NaN);
  switch (rule) {
    case 'tsmom': return c.map((_, i) => ret(i, 365) > 0);
    case 'cryptoMom': return c.map((_, i) => ret(i, 28) > 0);
    case 'multiTrend': return c.map((_, i) => i >= 365 && [30, 91, 365].filter((d) => ret(i, d) > 0).length >= 2);
    case 'dualMom': {
      const other = new Map((ref ?? []).map((b) => [b.time, b.close]));
      return c.map((_, i) => {
        const mine = ret(i, 365);
        if (!(mine > 0)) return false;
        const a = other.get(bars[i].time), b = i >= 365 ? other.get(bars[i - 365].time) : undefined;
        return a === undefined || b === undefined || mine >= a / b - 1;
      });
    }
    case 'trend200': { const ma = I.sma(c, 200); return c.map((x, i) => ok(ma[i]) && x > ma[i]); }
    case 'golden': { const f = I.sma(c, 50), s = I.sma(c, 200); return c.map((_, i) => ok(s[i]) && f[i] > s[i]); }
    case 'trend': { const ma = I.sma(c, 50); return c.map((x, i) => ok(ma[i]) && x > ma[i]); }
    case 'ema': { const f = I.ema(c, 20), s = I.ema(c, 50); return c.map((_, i) => ok(s[i]) && f[i] > s[i]); }
    case 'ma520': { const f = I.sma(c, 5), s = I.sma(c, 20); return c.map((_, i) => ok(s[i]) && f[i] > s[i]); }
    case 'triple': { const a = I.sma(c, 4), b = I.sma(c, 9), d = I.sma(c, 18); return c.map((_, i) => ok(d[i]) && a[i] > b[i] && b[i] > d[i]); }
    case 'macd': { const fast = I.ema(c, 12), slow = I.ema(c, 26); const macd = fast.map((v, i) => v - slow[i]); const sig = emaFrom(macd, 9); return c.map((_, i) => ok(sig[i]) && macd[i] > sig[i]); }
    case 'ichimoku': { const k = cloud(bars); return c.map((x, i) => ok(k.a[i]) && ok(k.b[i]) && x > Math.max(k.a[i], k.b[i])); }
    case 'psar': return psar(bars).up;
    case 'aroon': { const a = aroon(bars); return c.map((_, i) => ok(a.up[i]) && a.up[i] > a.down[i]); }
    case 'adx': { const d = dmi(bars); return latch(n, (i) => d.adx[i] > 25 && d.pdi[i] > d.mdi[i], (i) => d.pdi[i] < d.mdi[i]); }
    case 'keltner': { const k = keltner(bars); return latch(n, (i) => c[i] > k.up[i], (i) => c[i] < k.mid[i]); }
    case 'break': { const hi = prevHigh(bars, 20), lo = prevLow(bars, 10); return latch(n, (i) => c[i] > hi[i], (i) => c[i] < lo[i]); }
    case 'turtle2': { const hi = prevHigh(bars, 55), lo = prevLow(bars, 20); return latch(n, (i) => c[i] > hi[i], (i) => c[i] < lo[i]); }
    case 'donchian': { const hi = prevHigh(bars, 20), lo = prevLow(bars, 20); return latch(n, (i) => c[i] > hi[i], (i) => c[i] < lo[i]); }
    case 'rsi': { const r = I.rsi(c); return latch(n, (i) => r[i] < 30, (i) => r[i] > 55); }
    case 'boll': { const b = I.boll(c); return latch(n, (i) => c[i] < b.lo[i], (i) => c[i] > b.mid[i]); }
    case 'rsi2': { const r = I.rsi(c, 2), long = I.sma(c, 200), fast = I.sma(c, 5); return latch(n, (i) => c[i] > long[i] && r[i] < 5, (i) => c[i] > fast[i]); }
    case 'double7': {
      const long = I.sma(c, 200);
      const edge = (i: number, low: boolean) => { if (i < 6) return false; for (let j = i - 6; j < i; j++) if (low ? c[j] < c[i] : c[j] > c[i]) return false; return true; };
      return latch(n, (i) => c[i] > long[i] && edge(i, true), (i) => edge(i, false));
    }
  }
}

/** A line the rule looks at, for the chart. `dots` draws points instead of a line (the parabolic stop). */
export interface Overlay { values: number[]; tone: 'main' | 'fast' | 'mid' | 'up' | 'down'; dots?: boolean }
export function overlays(rule: RuleId, bars: Bar[], made?: MadeSpec): Overlay[] {
  if (made) return specLines(made, bars);
  const c = bars.map((b) => b.close);
  const L = (values: number[], tone: Overlay['tone']): Overlay => ({ values, tone });
  switch (rule) {
    case 'trend': case 'trendDca': return [L(I.sma(c, 50), 'main')];
    case 'trend200': case 'double7': return [L(I.sma(c, 200), 'main')];
    case 'golden': return [L(I.sma(c, 50), 'fast'), L(I.sma(c, 200), 'main')];
    case 'ema': return [L(I.ema(c, 20), 'fast'), L(I.ema(c, 50), 'main')];
    case 'ma520': return [L(I.sma(c, 5), 'fast'), L(I.sma(c, 20), 'main')];
    case 'triple': return [L(I.sma(c, 4), 'fast'), L(I.sma(c, 9), 'mid'), L(I.sma(c, 18), 'main')];
    case 'macd': return [L(I.ema(c, 12), 'fast'), L(I.ema(c, 26), 'main')];
    case 'smart': return [L(I.sma(c, 20), 'main')];
    case 'rsi2': return [L(I.sma(c, 5), 'fast'), L(I.sma(c, 200), 'main')];
    case 'boll': { const b = I.boll(c); return [L(b.up, 'main'), L(b.mid, 'mid'), L(b.lo, 'main')]; }
    case 'break': return [L(prevHigh(bars, 20), 'up'), L(prevLow(bars, 10), 'down')];
    case 'turtle2': return [L(prevHigh(bars, 55), 'up'), L(prevLow(bars, 20), 'down')];
    case 'donchian': return [L(prevHigh(bars, 20), 'up'), L(prevLow(bars, 20), 'down')];
    case 'ichimoku': { const k = cloud(bars); return [L(k.a, 'fast'), L(k.b, 'main')]; }
    case 'keltner': { const k = keltner(bars); return [L(k.up, 'main'), L(k.mid, 'mid')]; }
    case 'psar': return [{ values: psar(bars).sar, tone: 'main', dots: true }];
    default: return [];
  }
}
/** The pane a rule needs under the price chart: a return over some days (hold above zero) or RSI with its levels. */
export type Pane = { kind: 'mom'; days: number } | { kind: 'rsi'; period: number; levels: number[] };
export function paneOf(rule: RuleId, made?: MadeSpec): Pane | null {
  if (made) return specPane(made);
  switch (rule) {
    case 'tsmom': case 'multiTrend': case 'dualMom': return { kind: 'mom', days: 365 };
    case 'cryptoMom': return { kind: 'mom', days: 28 };
    case 'rsi': return { kind: 'rsi', period: 14, levels: [30, 55] };
    case 'rsiDca': return { kind: 'rsi', period: 14, levels: [35, 65] };
    case 'rsi2': return { kind: 'rsi', period: 2, levels: [5] };
    default: return null;
  }
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
export function scorePosition(rule: PositionRule, market: cex.Market, bars: Bar[], window = WINDOW, ref?: Bar[]): Agent | null {
  const def = POSITION_RULES.find((r) => r.id === rule)!;
  return run({ id: `${rule}-${market.symbol}`, rule, style: def.style, risk: def.risk }, positions(rule, bars, ref), NEED[rule] ?? WARMUP, market, bars, window);
}
/** A made agent, scored exactly like the built-in ones: same fees, same window, same numbers. */
export function scoreMade(spec: MadeSpec, market: cex.Market, bars: Bar[], window = WINDOW): Agent | null {
  const a = run({ id: MADE_PREFIX + spec.id, rule: 'made', style: 'trend', risk: 3 }, specPositions(spec, bars), specNeed(spec), market, bars, window);
  return a && { ...a, made: spec };
}
function run(who: { id: string; rule: RuleId; style: Style; risk: Risk }, pos: boolean[], need: number, market: cex.Market, bars: Bar[], window: number): Agent | null {
  const { rule } = who, def = who;
  const start = Math.max(need, bars.length - 1 - window);
  if (bars.length - 1 - start < Math.min(MIN_DAYS, window)) return null;
  const runnable = isRunnable(market.base);
  const fee = runnable ? FEE_HSKSWAP : FEE_HASHKEY;
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
    id: who.id, kind: 'position', rule, style: def.style, risk: def.risk, tier: TIER[rule], base: market.base,
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
  if (a.made) return a.market ? scoreMade(a.made, a.market, await hashkeyDaily(a.market), window) : null;
  if (a.kind === 'collect') return isRunnable(a.base) ? scoreCollect(a.rule as CollectRule, a.base, await gateDaily(a.base), window) : null;
  return a.market ? scorePosition(a.rule as PositionRule, a.market, await hashkeyDaily(a.market), window, await refBars(a.market)) : null;
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
  const [bars, ref] = await Promise.all([hashkeyDaily(m), refBars(m)]);
  return POSITION_RULES.map((r) => scorePosition(r.id, m, bars, WINDOW, ref)).filter((a): a is Agent => a !== null);
}
/** The agents someone made for this market, scored on the same candles. */
export async function madeAgents(m: cex.Market): Promise<Agent[]> {
  const mine = madeList().filter((s) => s.market === m.symbol);
  if (!mine.length) return [];
  const bars = await hashkeyDaily(m);
  return mine.map((s) => scoreMade(s, m, bars)).filter((a): a is Agent => a !== null);
}
/** The other major coin, for dual momentum: ETH when the market is BTC, BTC for everything else. Missing is not fatal. */
function refBars(m: cex.Market): Promise<Bar[]> {
  const other = cex.MARKETS.find((x) => x.symbol === (m.base === 'BTC' ? 'ETHUSDT-PERPETUAL' : 'BTCUSDT-PERPETUAL'));
  return other ? hashkeyDaily(other).catch(() => []) : Promise.resolve([]);
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
  if (id.startsWith(MADE_PREFIX)) {
    const spec = madeById(id), m = spec && cex.MARKETS.find((x) => x.symbol === spec.market);
    return spec && m ? scoreMade(spec, m, await hashkeyDaily(m)) : null;
  }
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
