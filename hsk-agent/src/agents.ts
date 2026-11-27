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
import { INTERVAL_SECONDS, PER_DAY, WINDOW_DAYS, intervalOf, specLines, specNeed, specPane, specPositions, type MadeSpec, type SpecInterval } from './spec.ts';
import { MADE_PREFIX, madeById, madeList } from './madeStore.ts';

export type PositionRule =
  | 'tsmom' | 'multiTrend' | 'dualMom' | 'trend200' | 'golden' | 'break' | 'turtle2' | 'donchian' | 'ma520' | 'triple'
  | 'macd' | 'ichimoku' | 'keltner' | 'psar' | 'adx' | 'aroon' | 'cryptoMom' | 'rsi2' | 'double7'
  | 'trend' | 'ema' | 'rsi' | 'boll' | ShortRule | QuantRule;
/**
 * Short-term agents: standard rules run on hourly or 4-hour candles, so they trade in hours and days instead of
 * weeks. Where the source is a daily rule this is Moa's shorter version, with no published test (PROOF 'none').
 */
export type ShortRule = 'rsi2h' | 'rsi2q' | 'ema921h' | 'macd4h' | 'bollh' | 'rsih' | 'donch1h' | 'donch4h';
/**
 * The research set (scratchpad/quant-research.md, "implement in this order" #1–#7), daily candles:
 *  - holding a share of the money between 0 and 1 (WEIGHT_RULES): volatility-targeted holding (B1), the Donchian
 *    ensemble with midpoint stops and volatility sizing (A1), multi-horizon momentum (A3), core plus trend (B3) and
 *    the price-above-average ensemble (A2);
 *  - in or out with a chandelier stop (C1): the 20-day breakout (A4) and the Turtle/Donchian rules with the stop added.
 */
export type QuantRule = WeightRule | 'brkAtr' | 'breakC' | 'turtle2C' | 'donchianC';
export type WeightRule = 'volTarget' | 'donchEns' | 'tsmom3' | 'coreTrend' | 'maEns';
/** Each weight rule's rebalance band: the share held only moves when its target moves this far (research: B1 15 points, the others 10). */
export const BAND: Record<WeightRule, number> = { volTarget: 0.15, donchEns: 0.10, tsmom3: 0.10, coreTrend: 0.10, maEns: 0.10 };
export const isWeightRule = (rule: RuleId): rule is WeightRule => rule in BAND;
/**
 * Retired by the research: the evidence is against them on BTC and ETH (large coins show momentum, not reversal) or
 * they cannot survive the costs. Hidden from the market, rankings and Moa's picks; still scored for anyone who hired one.
 */
export const isRetired = (a: { rule: RuleId; base: string }) => a.rule === 'macd' || ((a.rule === 'rsi2' || a.rule === 'double7' || a.rule === 'boll') && (a.base === 'BTC' || a.base === 'ETH'));
/** Demoted to "classic": single-setting rules the research says newer ensembles supersede, or with no crypto evidence. */
export const DEMOTED: ReadonlySet<RuleId> = new Set<RuleId>(['golden', 'ichimoku', 'trend200', 'tsmom', 'break', 'turtle2', 'donchian', 'psar', 'adx', 'aroon', 'keltner']);
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
  // Standard indicator rules on shorter candles (the indicator itself has no preferred candle length) ...
  ema921h: 2, macd4h: 2, bollh: 2, rsih: 2,
  // ... and shorter versions of published daily systems: Moa's own variation.
  rsi2h: 3, rsi2q: 3, donch1h: 3, donch4h: 3,
  // The research set: published strategies (tier 1), and Moa's combinations of published parts (tier 3).
  volTarget: 1, donchEns: 1, tsmom3: 1, maEns: 1, brkAtr: 1, coreTrend: 3, breakC: 3, turtle2C: 3, donchianC: 3,
};
/**
 * What stands behind a rule, said plainly on every agent:
 *  paper: tested in a published paper; record: run with real money and published afterwards;
 *  book: published by its author and widely used, with no formal test of this exact rule;
 *  common: a widely followed signal with no single author; none: nothing published, only the backtest here.
 */
export type Proof = 'paper' | 'record' | 'book' | 'common' | 'none';
/**
 * How long a strategy is built to hold, from the length of the history its rule looks at: months to a year (long),
 * a few weeks (swing), or days (short). It is a property of the rule, not of how one backtest happened to go.
 */
export type Horizon = 'long' | 'swing' | 'short';
export const HORIZONS: Horizon[] = ['long', 'swing', 'short'];
export const HORIZON: Record<Exclude<RuleId, 'made'>, Horizon> = {
  tsmom: 'long', multiTrend: 'long', dualMom: 'long', trend200: 'long', golden: 'long', turtle2: 'long',
  daily: 'long', smart: 'long', trendDca: 'long', rsiDca: 'long',
  break: 'swing', donchian: 'swing', macd: 'swing', ichimoku: 'swing', keltner: 'swing', adx: 'swing', aroon: 'swing', cryptoMom: 'swing', trend: 'swing', ema: 'swing', boll: 'swing',
  ma520: 'short', triple: 'short', psar: 'short', rsi2: 'short', double7: 'short', rsi: 'short',
  rsi2h: 'short', rsi2q: 'short', ema921h: 'short', macd4h: 'short', bollh: 'short', rsih: 'short', donch1h: 'short', donch4h: 'short',
  volTarget: 'long', coreTrend: 'long', turtle2C: 'long', donchEns: 'swing', tsmom3: 'swing', maEns: 'swing', brkAtr: 'swing', breakC: 'swing', donchianC: 'swing',
};
/** A made rule is placed by the longest stretch of days any of its conditions looks at. */
export function horizonOf(a: { rule: RuleId; made?: MadeSpec }): Horizon {
  if (a.rule !== 'made') return HORIZON[a.rule];
  const days = Math.max(0, ...[...(a.made?.buy ?? []), ...(a.made?.sell ?? [])].flatMap((c) => [c.a, c.b]).filter((x) => x.k !== 'num').map((x) => x.n ?? 0));
  return days >= 100 ? 'long' : days >= 15 ? 'swing' : 'short';
}

export const PROOF: Record<RuleId, Proof> = {
  tsmom: 'paper', multiTrend: 'paper', dualMom: 'paper', trend200: 'paper', cryptoMom: 'paper',
  break: 'record', turtle2: 'record',
  donchian: 'book', ma520: 'book', triple: 'book', macd: 'book', ichimoku: 'book', keltner: 'book', psar: 'book', adx: 'book', aroon: 'book', rsi2: 'book', double7: 'book', daily: 'book',
  golden: 'common',
  trend: 'none', ema: 'none', rsi: 'none', boll: 'none', smart: 'none', trendDca: 'none', rsiDca: 'none', made: 'none',
  rsi2h: 'none', rsi2q: 'none', ema921h: 'none', macd4h: 'none', bollh: 'none', rsih: 'none', donch1h: 'none', donch4h: 'none',
  // Peer-reviewed or working-paper tests (each text says which, and that the costs and assets differed); a practitioner
  // rule for the chandelier stop; nothing published for the 50/50 blend.
  volTarget: 'paper', donchEns: 'paper', tsmom3: 'paper', maEns: 'paper', brkAtr: 'paper', coreTrend: 'none', breakC: 'book', turtle2C: 'book', donchianC: 'book',
};
/** The candles a short-term rule decides on. Every other rule is daily. */
export const SHORT_INTERVAL: Record<ShortRule, Exclude<SpecInterval, '1d'>> = {
  rsi2h: '1h', rsi2q: '4h', ema921h: '1h', macd4h: '4h', bollh: '1h', rsih: '1h', donch1h: '1h', donch4h: '4h',
};
/** The candle interval any rule decides on. */
export const ruleInterval = (rule: RuleId): SpecInterval => (rule in SHORT_INTERVAL ? SHORT_INTERVAL[rule as ShortRule] : '1d');
/** Short-term rules that are an existing rule unchanged, only on shorter candles. */
const SAME_AS: Partial<Record<ShortRule, PositionRule>> = { macd4h: 'macd', bollh: 'boll', rsih: 'rsi', donch1h: 'break', donch4h: 'break' };
/** Days of history a rule needs before its first decision (the slow ones need their long averages). */
const NEED: Partial<Record<RuleId, number>> = { tsmom: 365, multiTrend: 365, dualMom: 365, trend200: 200, golden: 200, rsi2: 200, double7: 200, ichimoku: 90, rsi2h: 200, rsi2q: 200, donchEns: 151, tsmom3: 92, coreTrend: 92, maEns: 100 };

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
  { id: 'rsi2h', style: 'revert', risk: 3 },
  { id: 'rsi2q', style: 'revert', risk: 3 },
  { id: 'ema921h', style: 'trend', risk: 3 },
  { id: 'macd4h', style: 'trend', risk: 3 },
  { id: 'bollh', style: 'revert', risk: 3 },
  { id: 'rsih', style: 'revert', risk: 3 },
  { id: 'donch1h', style: 'trend', risk: 3 },
  { id: 'donch4h', style: 'trend', risk: 3 },
  { id: 'volTarget', style: 'trend', risk: 2 },
  { id: 'donchEns', style: 'trend', risk: 2 },
  { id: 'tsmom3', style: 'trend', risk: 2 },
  { id: 'coreTrend', style: 'trend', risk: 2 },
  { id: 'maEns', style: 'trend', risk: 2 },
  { id: 'brkAtr', style: 'trend', risk: 3 },
  { id: 'breakC', style: 'trend', risk: 3 },
  { id: 'turtle2C', style: 'trend', risk: 2 },
  { id: 'donchianC', style: 'trend', risk: 3 },
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
  /** Position agents: the average share of the money held in the coin (1 while in for an in/out rule), and every
   *  trade made (entries, exits and a weight agent's resizes), so the fee drag can be read off. */
  exposure?: number;
  moves?: number;
  /** A weight agent: today's target share of its budget (before the band) and the band it rebalances on. */
  target?: number;
  band?: number;
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
  /** The candles it decides on, when they are not daily (a made agent on 4-hour or hourly candles). `days` stays in
   *  days either way; `trades`, `equity` and `marks` are per candle. */
  interval?: SpecInterval;
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
  /** A weight agent changing the size it holds (not an entry or an exit); `mult` is the new share. */
  resize?: true;
}

/* ---------- candles, cached for 10 minutes so live signals refresh ---------- */

type Bar = cex.Candle;
const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; p: Promise<Bar[]> }>();
function cached(key: string, load: () => Promise<Bar[]>, ttl = TTL): Promise<Bar[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
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
/** The longest look-back a condition can ask for (TERM_N's maximum), plus room for the indicators to settle. */
const LOOKBACK_BARS = 460;
/**
 * Closed candles of a made agent's interval, oldest first, from HashKey Global: daily is `dailyHistory`; 4-hour and
 * hourly are paged back (1,000 per request) far enough for the scoring window and the longest look-back. The candle
 * still forming is left out, so a decision is only ever made on a closed candle and cannot flip within the hour.
 * Refreshed every two minutes, so an hourly agent sees a new candle soon after it closes.
 */
export function madeHistory(m: cex.Market, interval: SpecInterval, now = Date.now()): Promise<Bar[]> {
  if (interval === '1d') return dailyHistory(m);
  return cached(`hk:${m.symbol}:${interval}`, async () => {
    const want = WINDOW_DAYS[interval] * PER_DAY[interval] + LOOKBACK_BARS;
    let out: Bar[] = [];
    let end: number | undefined;
    for (let page = 0; page < 4 && out.length < want; page++) {
      const xs = await cex.klines(m, interval, 1000, end);
      if (!xs.length) break;
      out = [...xs.filter((b) => !out.length || b.time < out[0].time), ...out];
      if (xs.length < 1000) break;
      end = xs[0].time * 1000 - 1;
    }
    return closedOnly(out, interval, now);
  }, 2 * 60_000);
}
/** Drop the last candle while it is still open (its interval has not ended yet). */
export const closedOnly = (bars: Bar[], interval: SpecInterval, now = Date.now()) =>
  bars.length && bars[bars.length - 1].time + INTERVAL_SECONDS[interval] > now / 1000 ? bars.slice(0, -1) : bars;
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
 * The chandelier exit (Charles LeBeau; research C1) on top of any in/out rule: once in, the stop is the highest high
 * of the last `n` candles minus `k` average true ranges (Wilder, `n` candles), and it only ever moves up. A close
 * under it exits, and the agent stays out until the rule itself goes out and gives a fresh entry. Closes only.
 */
export function withTrailingStop(pos: boolean[], bars: Bar[], k = 3, n = 22): boolean[] {
  const atr = atrSeries(bars, n), hh = prevHighIncl(bars, n), out: boolean[] = [];
  let on = false, stop = -Infinity, wait = false;
  for (let i = 0; i < pos.length; i++) {
    const c = bars[i].close, level = Number.isFinite(atr[i]) ? hh[i] - k * atr[i] : -Infinity;
    if (!pos[i]) { on = false; wait = false; out.push(false); continue; }
    if (wait) { out.push(false); continue; }
    if (!on) { on = true; stop = level; out.push(true); continue; }
    stop = Math.max(stop, level);
    if (c < stop) { on = false; wait = true; out.push(false); continue; }
    out.push(true);
  }
  return out;
}
/** Highest high of the n candles ending today (the chandelier's anchor). */
const prevHighIncl = (bars: Bar[], n: number) => bars.map((_, i) => { if (i < n - 1) return NaN; let v = -Infinity; for (let j = i - n + 1; j <= i; j++) v = Math.max(v, bars[j].high); return v; });

/* ----- the research set's sizing: a share of the money per day ----- */

const logRets = (c: number[]) => c.map((x, i) => (i ? Math.log(x / c[i - 1]) : NaN));
/** Annualised EWMA volatility of daily log returns with the given half-life in days (Harvey et al. 2018). */
export function ewmaVol(c: number[], halfLife = 20): number[] {
  const lam = 0.5 ** (1 / halfLife), r = logRets(c), out = NANS(c.length);
  let v = NaN;
  for (let i = 1; i < c.length; i++) {
    if (i < halfLife) continue;
    if (Number.isNaN(v)) { let s = 0; for (let j = 1; j <= i; j++) s += r[j] ** 2; v = s / i; } else v = lam * v + (1 - lam) * r[i] ** 2;
    out[i] = Math.sqrt(v * 365);
  }
  return out;
}
/** Annualised standard deviation of the last n daily returns. */
function rollVol(c: number[], n: number): number[] {
  const r = logRets(c);
  return c.map((_, i) => { if (i < n) return NaN; let m = 0; for (let j = i - n + 1; j <= i; j++) m += r[j]; m /= n; let s = 0; for (let j = i - n + 1; j <= i; j++) s += (r[j] - m) ** 2; return Math.sqrt((s / (n - 1)) * 365); });
}
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
/** Volatility-targeted holding (B1): min(1, 50% / EWMA vol, 20-day half-life). */
const volWeight = (c: number[]) => ewmaVol(c, 20).map((v) => (Number.isFinite(v) && v > 0 ? Math.min(1, 0.5 / v) : 0));
/** Multi-horizon momentum (A3): the share of the 7-, 28- and 91-day returns that are positive, updated once a week (Mondays, UTC). */
function momScore(bars: Bar[]): number[] {
  const c = bars.map((b) => b.close), out: number[] = [];
  let held = 0;
  for (let i = 0; i < c.length; i++) {
    if (i >= 91 && new Date(bars[i].time * 1000).getUTCDay() === 1) held = [7, 28, 91].filter((d) => c[i] > c[i - d]).length / 3;
    out.push(i >= 91 ? held : 0);
  }
  return out;
}
/** Donchian ensemble (A1): per lookback, in on a close above the prior n-day high close; a stop at the n-day close range's midpoint that only rises. */
function donchianVotes(c: number[], lookbacks: number[]): number[] {
  const votes = new Array<number>(c.length).fill(0);
  for (const n of lookbacks) {
    let on = false, stop = -Infinity;
    for (let i = n; i < c.length; i++) {
      let hiPrior = -Infinity, hi = -Infinity, lo = Infinity;
      for (let j = i - n; j < i; j++) hiPrior = Math.max(hiPrior, c[j]);
      for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, c[j]); lo = Math.min(lo, c[j]); }
      const mid = (hi + lo) / 2;
      if (!on && c[i] > hiPrior) { on = true; stop = mid; } else if (on) { stop = Math.max(stop, mid); if (c[i] < stop) on = false; }
      if (on) votes[i] += 1 / lookbacks.length;
    }
  }
  return votes;
}
/** The target share of the money for a weight rule on each day, before the rebalance band. */
export function targets(rule: WeightRule, bars: Bar[]): number[] {
  const c = bars.map((b) => b.close);
  switch (rule) {
    case 'volTarget': return volWeight(c);
    case 'donchEns': { const v = donchianVotes(c, [10, 20, 30, 60, 90, 150]), sd = rollVol(c, 90); return v.map((x, i) => clamp01(Number.isFinite(sd[i]) && sd[i] > 0 ? x * (0.25 / sd[i]) : 0)); }
    case 'tsmom3': return momScore(bars);
    case 'coreTrend': { const w = volWeight(c), m = momScore(bars); return w.map((x, i) => clamp01(0.5 * x + 0.5 * m[i] * x)); }
    case 'maEns': { const ma = [20, 50, 100].map((n) => I.sma(c, n)); return c.map((x, i) => (Number.isFinite(ma[2][i]) ? ma.filter((m) => x > m[i]).length / 3 : 0)); }
  }
}
/** Hold the share until the target moves at least `band` away from it (research: rebalance only on a big enough move). */
export function banded(target: number[], band: number): number[] {
  let w = 0;
  return target.map((x) => { const v = clamp01(x); if (Math.abs(v - w) >= band - 1e-9) w = v; return w; });
}
/** The 20-day breakout (A4) with the chandelier stop: in on a close at the 20-day high close, out under the stop. */
function breakoutAtr(bars: Bar[]): boolean[] {
  const c = bars.map((b) => b.close), atr = atrSeries(bars, 22), hh = prevHighIncl(bars, 22), out: boolean[] = [];
  let on = false, stop = -Infinity;
  for (let i = 0; i < c.length; i++) {
    let top = -Infinity; if (i >= 21) for (let j = i - 19; j <= i; j++) top = Math.max(top, c[j]);
    const level = Number.isFinite(atr[i]) ? hh[i] - 3 * atr[i] : NaN;
    if (!on && i >= 22 && Number.isFinite(level) && c[i] >= top) { on = true; stop = level; } else if (on) { stop = Math.max(stop, level); if (c[i] < stop) on = false; }
    out.push(on);
  }
  return out;
}

/**
 * Position per day (decided at that day's close). `ref` is the other major coin's candles, used only by the
 * dual-momentum rule (which holds this coin only while it is also the stronger of the two).
 */
export function positions(rule: PositionRule, bars: Bar[], ref?: Bar[]): boolean[] {
  const same = SAME_AS[rule as ShortRule];
  if (same) return positions(same, bars, ref);
  // A weight rule is "in" on any day it holds a share (its size is in exposure()).
  if (isWeightRule(rule)) return banded(targets(rule, bars), BAND[rule]).map((w) => w > 0);
  if (rule === 'brkAtr') return breakoutAtr(bars);
  if (rule === 'breakC' || rule === 'turtle2C' || rule === 'donchianC') return withTrailingStop(positions(rule === 'breakC' ? 'break' : rule === 'turtle2C' ? 'turtle2' : 'donchian', bars), bars, 3, 22);
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
    // Connors' published entry level (RSI(2) under 10), on hourly or 4-hour candles: above the 200-candle average.
    case 'rsi2h': case 'rsi2q': { const r = I.rsi(c, 2), long = I.sma(c, 200), fast = I.sma(c, 5); return latch(n, (i) => c[i] > long[i] && r[i] < 10, (i) => c[i] > fast[i]); }
    case 'ema921h': { const f = I.ema(c, 9), s = I.ema(c, 21); return c.map((_, i) => i >= 21 && f[i] > s[i]); }
    case 'double7': {
      const long = I.sma(c, 200);
      const edge = (i: number, low: boolean) => { if (i < 6) return false; for (let j = i - 6; j < i; j++) if (low ? c[j] < c[i] : c[j] > c[i]) return false; return true; };
      return latch(n, (i) => c[i] > long[i] && edge(i, true), (i) => edge(i, false));
    }
    default: return new Array<boolean>(n).fill(false);
  }
}

/** A line the rule looks at, for the chart. `dots` draws points instead of a line (the parabolic stop). */
export interface Overlay { values: number[]; tone: 'main' | 'fast' | 'mid' | 'up' | 'down'; dots?: boolean }
export function overlays(rule: RuleId, bars: Bar[], made?: MadeSpec): Overlay[] {
  if (made) return specLines(made, bars);
  const same = SAME_AS[rule as ShortRule];
  if (same) return overlays(same, bars);
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
    case 'rsi2': case 'rsi2h': case 'rsi2q': return [L(I.sma(c, 5), 'fast'), L(I.sma(c, 200), 'main')];
    case 'ema921h': return [L(I.ema(c, 9), 'fast'), L(I.ema(c, 21), 'main')];
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
  const same = SAME_AS[rule as ShortRule];
  if (same) return paneOf(same);
  switch (rule) {
    case 'tsmom': case 'multiTrend': case 'dualMom': return { kind: 'mom', days: 365 };
    case 'cryptoMom': return { kind: 'mom', days: 28 };
    case 'rsi': return { kind: 'rsi', period: 14, levels: [30, 55] };
    case 'rsiDca': return { kind: 'rsi', period: 14, levels: [35, 65] };
    case 'rsi2': return { kind: 'rsi', period: 2, levels: [5] };
    case 'rsi2h': case 'rsi2q': return { kind: 'rsi', period: 2, levels: [10] };
    default: return null;
  }
}

function stats(rets: number[], perDay = 1) {
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365 * perDay) : 0;
}

/**
 * Long-only backtest over the window (the last three years by default, any number of days, or `Infinity` for
 * all the history there is). Fees on every entry and exit. A younger coin is scored over what it has after the
 * rule's warm-up; with too little left the agent is not offered at all.
 */
/** What a rule holds each day: in or out, or for a weight rule the share of the money after its rebalance band. */
export function exposure(rule: PositionRule, bars: Bar[], ref?: Bar[]): Exposure[] {
  return isWeightRule(rule) ? banded(targets(rule, bars), BAND[rule]) : positions(rule, bars, ref);
}
export function scorePosition(rule: PositionRule, market: cex.Market, bars: Bar[], window?: number, ref?: Bar[]): Agent | null {
  const def = POSITION_RULES.find((r) => r.id === rule)!;
  // `bars` are candles of the rule's interval (madeHistory for a short-term rule); the window is in days.
  const iv = ruleInterval(rule);
  const a = run({ id: `${rule}-${market.symbol}`, rule, style: def.style, risk: def.risk }, exposure(rule, bars, ref), NEED[rule] ?? WARMUP, market, bars, window ?? WINDOW_DAYS[iv], PER_DAY[iv]);
  if (!a) return null;
  // A weight agent's live signal: today's target share (before the band) and its band; the runner rebalances on it.
  const sized = isWeightRule(rule) && bars.length ? { target: clamp01(targets(rule, bars)[bars.length - 1]), band: BAND[rule] } : {};
  return { ...a, ...sized, ...(iv !== '1d' ? { interval: iv } : {}) };
}
/**
 * A made agent, scored exactly like the built-in ones: same fees, same decision code, same numbers. `bars` are
 * candles of the agent's interval (see madeHistory); `window` is in days, by default the interval's own window.
 */
export function scoreMade(spec: MadeSpec, market: cex.Market, bars: Bar[], window?: number): Agent | null {
  const iv = intervalOf(spec);
  const a = run({ id: MADE_PREFIX + spec.id, rule: 'made', style: 'trend', risk: 3 }, specPositions(spec, bars), specNeed(spec), market, bars, window ?? WINDOW_DAYS[iv], PER_DAY[iv]);
  return a && { ...a, made: spec, ...(iv === '1d' ? {} : { interval: iv }) };
}
/** A made agent on its own candles: what the app's runner, the server's runner and its card all read. */
export async function scoreMadeLive(spec: MadeSpec, market: cex.Market, window?: number): Promise<Agent | null> {
  return scoreMade(spec, market, await madeHistory(market, intervalOf(spec)), window);
}
/** An intraday agent needs at least this many days of its candles after its look-back to be scored at all. */
const MIN_INTRADAY_DAYS = 30;
/**
 * The position on each candle: in or out (boolean), or a share of the money between 0 and 1 (a number, for rules that
 * size their exposure, e.g. by volatility). The fee is paid on the share that changes hands, so a boolean rule pays
 * exactly what it always did.
 */
export type Exposure = boolean | number;
const share = (x: Exposure | undefined) => (typeof x === 'number' ? Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0)) : x ? 1 : 0);
function run(who: { id: string; rule: RuleId; style: Style; risk: Risk }, pos: Exposure[], need: number, market: cex.Market, bars: Bar[], window: number, perDay = 1): Agent | null {
  const { rule } = who, def = who;
  // The window is in days; on intraday candles it covers that many days' worth of candles.
  const span = window === Infinity ? Infinity : Math.round(window * perDay);
  const start = Math.max(need, bars.length - 1 - span);
  if (bars.length - 1 - start < Math.min(perDay === 1 ? MIN_DAYS : MIN_INTRADAY_DAYS * perDay, span)) return null;
  const runnable = isRunnable(market.base);
  const fee = runnable ? FEE_HSKSWAP : FEE_HASHKEY;
  let eq = 1, peak = 1, maxDd = 0, trades = 0, inDays = 0, held = 0, moves = 0;
  const rets: number[] = [];
  const equity: { time: number; value: number }[] = [{ time: bars[start].time, value: 1 }];
  const bench: { time: number; value: number }[] = [{ time: bars[start].time, value: 1 }];
  const marks: Mark[] = [];
  let entry = 0;
  for (let i = start; i < bars.length - 1; i++) {
    const was = i > start ? share(pos[i - 1]) : 0, now = share(pos[i]);
    let day = 1;
    if (now > 0 && was === 0) { trades++; entry = bars[i].close; marks.push({ time: bars[i].time, side: 'buy', price: entry }); }
    if (now === 0 && was > 0) marks.push({ time: bars[i].time, side: 'sell', price: bars[i].close, ret: (bars[i].close / entry) * (1 - fee) ** 2 - 1, ...(was < 1 ? { mult: 0 } : {}) });
    // A weight agent also resizes while it holds: each change is a trade, marked with the new share.
    if (now > 0 && was > 0 && now !== was) marks.push({ time: bars[i].time, side: now > was ? 'buy' : 'sell', price: bars[i].close, mult: Math.round(now * 100) / 100, resize: true });
    if (now > 0 && was === 0 && now < 1) marks[marks.length - 1].mult = Math.round(now * 100) / 100;
    if (now !== was) { day *= 1 - fee * Math.abs(now - was); moves++; }
    held += now;
    if (now > 0) { const r = bars[i + 1].close / bars[i].close; day *= now === 1 ? r : 1 + now * (r - 1); inDays++; }
    eq *= day;
    rets.push(day - 1);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    equity.push({ time: bars[i + 1].time, value: eq });
    bench.push({ time: bars[i + 1].time, value: bars[i + 1].close / bars[start].close });
  }
  const steps = bars.length - 1 - start;
  const days = perDay === 1 ? steps : Math.round(steps / perDay);
  const size = share(pos[bars.length - 1]), live = size > 0;
  return {
    id: who.id, kind: 'position', rule, style: def.style, risk: def.risk, tier: TIER[rule], base: market.base,
    runnable, source: 'hashkey', market, fee,
    days, from: bars[start].time, to: bars[bars.length - 1].time,
    total: eq - 1, hold: bars[bars.length - 1].close / bars[start].close - 1, maxDd, sharpe: stats(rets, perDay),
    trades, inMarket: inDays / steps, exposure: held / steps, moves, equity, bench, marks, live, mult: size, price: bars[bars.length - 1].close,
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
  if (a.made) return a.market ? scoreMadeLive(a.made, a.market, window) : null;
  if (a.kind === 'collect') return isRunnable(a.base) ? scoreCollect(a.rule as CollectRule, a.base, await gateDaily(a.base), window) : null;
  const iv = ruleInterval(a.rule);
  return a.market ? scorePosition(a.rule as PositionRule, a.market, await madeHistory(a.market, iv), window, iv === '1d' ? await refBars(a.market) : undefined) : null;
}

/** An agent that never traded in the window has no worst drop to judge, so it does not outrank one that did. */
export const idle = (a: Agent) => a.trades === 0;
/** Days since the agent's last buy or sell in the backtest; undefined when it never traded. */
export function lastTradeDays(a: Pick<Agent, 'marks' | 'to'>, now = Date.now() / 1000): number | undefined {
  if (!a.marks.length) return undefined;
  const last = Math.max(...a.marks.map((m) => m.time));
  return Math.max(0, Math.floor((now - last) / 86400));
}
/** How recent a trade must be for an agent to count as working now. */
export const ACTIVE_DAYS = 30;
/**
 * Working now: holding the coin, or it bought or sold within the last ACTIVE_DAYS. An agent that has sat in cash for
 * months has a small worst drop because it did nothing; it should not lead a list of agents to hire today.
 */
export const active = (a: Agent, now = Date.now() / 1000) => a.live || (lastTradeDays(a, now) ?? Infinity) <= ACTIVE_DAYS;
/** It made more than buying the coin at the start of the same window and holding it. */
export const beatsHold = (a: Pick<Agent, 'total' | 'hold'>) => a.total > a.hold;
/**
 * The default order everywhere: agents working now first; among them, the ones that beat just holding; then
 * published classics, then the smaller worst drop, then the better return. Agents that never traded come last.
 */
export const byMerit = (a: Agent, b: Agent) => Number(!active(a)) - Number(!active(b)) || Number(!beatsHold(a)) - Number(!beatsHold(b)) || a.tier - b.tier || Number(idle(a)) - Number(idle(b)) || a.maxDd - b.maxDd || b.total - a.total || a.id.localeCompare(b.id);

/** The position agents for any HashKey market (the chart's market may not be in the listing). */
export async function positionAgents(m: cex.Market, withRetired = false): Promise<Agent[]> {
  const [bars, ref] = await Promise.all([hashkeyDaily(m), refBars(m)]);
  const daily = POSITION_RULES.filter((r) => ruleInterval(r.id) === '1d' && (withRetired || !isRetired({ rule: r.id, base: m.base }))).map((r) => scorePosition(r.id, m, bars, WINDOW, ref));
  return [...daily, ...await shortAgents(m)].filter((a): a is Agent => a !== null);
}
/**
 * The short-term agents of a coin the vault can trade (BTC, ETH and HSK): each on its own hourly or 4-hour closed
 * candles. A coin whose shorter candles do not load still gets its daily agents.
 */
export async function shortAgents(m: cex.Market): Promise<Agent[]> {
  if (!isRunnable(m.base)) return [];
  const rules = POSITION_RULES.filter((r) => ruleInterval(r.id) !== '1d');
  const sets = await Promise.all((['1h', '4h'] as const).map(async (iv) => {
    const bars = await madeHistory(m, iv).catch(() => [] as Bar[]);
    return bars.length ? rules.filter((r) => ruleInterval(r.id) === iv).map((r) => scorePosition(r.id, m, bars)) : [];
  }));
  return sets.flat().filter((a): a is Agent => a !== null);
}
/** The agents someone made for this market, scored on the same candles. */
export async function madeAgents(m: cex.Market): Promise<Agent[]> {
  const mine = madeList().filter((s) => s.market === m.symbol);
  if (!mine.length) return [];
  return (await Promise.all(mine.map((s) => scoreMadeLive(s, m).catch(() => null)))).filter((a): a is Agent => a !== null);
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
    return spec && m ? scoreMadeLive(spec, m) : null;
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
  // Retired agents are still found here, so anyone who hired one keeps it working.
  return (await positionAgents(m, true)).find((a) => a.id === id) ?? null;
}

/** The backtest engine itself, for rules that size their exposure (0..1 per candle) or add a stop of their own. */
export const backtest = (id: string, rule: RuleId, pos: Exposure[], need: number, market: cex.Market, bars: Bar[], window: number, perDay = 1) =>
  run({ id, rule, style: 'trend', risk: 3 }, pos, need, market, bars, window, perDay);
