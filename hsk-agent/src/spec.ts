// An agent someone makes themselves: a rule written as data, not code.
//  - A rule is two short lists of conditions. It buys when every "buy" condition holds and sells when any "sell"
//    condition holds (with no sell conditions it simply holds while the buy conditions hold).
//  - A condition compares two things read off the daily candles: the price, an average, a recent high or low,
//    RSI, a return over some days, a Bollinger band, or a plain number.
// The same interpreter runs every made agent, decides on past days only, and is long-only on one coin, daily:
// the vault can only buy and sell spot, so there is nothing to express a short or leverage with.
// Three ways lead to the same data: start from a published strategy and change its numbers, add conditions by
// hand, or describe the rule in words (`parse`, a fixed reader of common phrases, no model involved).
import * as I from './indicators.ts';
import type { Candle } from './cex.ts';
import type { RuleId } from './agents.ts';

export type TermKind = 'price' | 'sma' | 'ema' | 'high' | 'low' | 'rsi' | 'ret' | 'bollUp' | 'bollLo' | 'num';
/** `n` is a number of candles of the agent's interval (days for a daily agent), or the value itself for a plain number. */
export interface Term { k: TermKind; n?: number }
export interface Cond { a: Term; op: 'above' | 'below'; b: Term }
export interface MadeSpec {
  id: string;
  name: string;
  /** HashKey market the rule reads (e.g. ETHUSDT-PERPETUAL). */
  market: string;
  buy: Cond[];
  sell: Cond[];
  createdAt: number;
  /** The published strategy it started from, if any. */
  from?: RuleId;
  /** The candles the rule reads and decides on, one decision per closed candle. Missing means daily (agents saved
   *  before intervals existed stay exactly as they were). */
  interval?: SpecInterval;
}

/* ---------- how often the rule looks: the candle interval ---------- */

export type SpecInterval = '1d' | '4h' | '1h';
export const SPEC_INTERVALS: SpecInterval[] = ['1d', '4h', '1h'];
/** Candles per day. */
export const PER_DAY: Record<SpecInterval, number> = { '1d': 1, '4h': 6, '1h': 24 };
/** Seconds per candle. */
export const INTERVAL_SECONDS: Record<SpecInterval, number> = { '1d': 86_400, '4h': 14_400, '1h': 3_600 };
/**
 * Days a made agent is scored over: three years of daily candles, one year of 4-hour candles, 90 days of hourly
 * candles. Each is about a thousand to two thousand decisions, and fits in a few requests of exchange history.
 */
export const WINDOW_DAYS: Record<SpecInterval, number> = { '1d': 1095, '4h': 365, '1h': 90 };
/** The interval a stored rule runs on. Anything unknown (an old or hand-edited record) is daily. */
export const intervalOf = (spec: object): SpecInterval => { const v = (spec as { interval?: unknown }).interval; return SPEC_INTERVALS.includes(v as SpecInterval) ? (v as SpecInterval) : '1d'; };

export const TERM_KINDS: TermKind[] = ['price', 'sma', 'ema', 'high', 'low', 'rsi', 'ret', 'bollUp', 'bollLo', 'num'];
/** What each kind needs: a number of days (with its sensible range and default), a value, or nothing. */
export const TERM_N: Record<TermKind, { min: number; max: number; dflt: number } | null> = {
  price: null, sma: { min: 2, max: 400, dflt: 50 }, ema: { min: 2, max: 400, dflt: 20 }, high: { min: 2, max: 400, dflt: 20 }, low: { min: 2, max: 400, dflt: 10 },
  rsi: { min: 2, max: 50, dflt: 14 }, ret: { min: 1, max: 400, dflt: 28 }, bollUp: { min: 5, max: 200, dflt: 20 }, bollLo: { min: 5, max: 200, dflt: 20 },
  num: { min: -1000, max: 1_000_000, dflt: 0 },
};
/** What a term is measured in, so only like things are compared: a price, an RSI reading, a percent. */
export const scaleOf = (k: TermKind) => (k === 'rsi' ? 'rsi' : k === 'ret' ? 'pct' : k === 'num' ? 'any' : 'price');
export const MAX_CONDS = 3;

const nans = (n: number) => new Array<number>(n).fill(NaN);
/** One value per day; NaN where there is not enough history yet. Highs and lows are of the n days before today. */
export function series(t: Term, bars: Candle[]): number[] {
  const c = bars.map((b) => b.close), n = Math.round(t.n ?? 0);
  switch (t.k) {
    case 'price': return c;
    case 'num': return c.map(() => t.n ?? 0);
    case 'sma': return I.sma(c, n);
    case 'ema': return I.ema(c, n);
    case 'rsi': return I.rsi(c, n);
    case 'ret': return c.map((x, i) => (i >= n ? (x / c[i - n] - 1) * 100 : NaN));
    case 'bollUp': return I.boll(c, n).up;
    case 'bollLo': return I.boll(c, n).lo;
    case 'high': return bars.map((_, i) => { if (i < n) return NaN; let v = -Infinity; for (let j = i - n; j < i; j++) v = Math.max(v, bars[j].high); return v; });
    case 'low': return bars.map((_, i) => { if (i < n) return NaN; let v = Infinity; for (let j = i - n; j < i; j++) v = Math.min(v, bars[j].low); return v; });
    default: return nans(c.length);
  }
}

/** In or out per day, decided at that day's close. A day with a missing value never triggers anything. */
export function specPositions(spec: Pick<MadeSpec, 'buy' | 'sell'>, bars: Candle[]): boolean[] {
  const test = (cs: Cond[]) => cs.map((c) => { const a = series(c.a, bars), b = series(c.b, bars); return (i: number) => (c.op === 'above' ? a[i] > b[i] : a[i] < b[i]); });
  const buy = test(spec.buy), sell = test(spec.sell);
  const pos: boolean[] = [];
  let on = false;
  for (let i = 0; i < bars.length; i++) {
    const wants = buy.length > 0 && buy.every((f) => f(i));
    if (!sell.length) on = wants;
    else if (!on && wants) on = true;
    else if (on && sell.some((f) => f(i))) on = false;
    pos.push(on);
  }
  return pos;
}

/** Days of history the rule needs before its first decision. */
export const specNeed = (spec: Pick<MadeSpec, 'buy' | 'sell'>) =>
  Math.max(30, ...[...spec.buy, ...spec.sell].flatMap((c) => [c.a, c.b]).map((t) => (t.k === 'num' || t.k === 'price' ? 0 : (t.n ?? 0) + (t.k === 'rsi' ? 20 : 1))));

export type Problem = 'noBuy' | 'tooMany' | 'range' | 'scale' | 'same' | 'name';
/** What is wrong with a rule, if anything (shown beside the editor; a rule with problems cannot be saved). */
export function problems(spec: Pick<MadeSpec, 'buy' | 'sell' | 'name'>): Problem[] {
  const out = new Set<Problem>();
  if (!spec.buy.length) out.add('noBuy');
  if (spec.buy.length > MAX_CONDS || spec.sell.length > MAX_CONDS) out.add('tooMany');
  if (!spec.name.trim()) out.add('name');
  for (const c of [...spec.buy, ...spec.sell]) {
    for (const t of [c.a, c.b]) { const r = TERM_N[t.k]; if (r && !(Number.isFinite(t.n) && t.n! >= r.min && t.n! <= r.max)) out.add('range'); }
    const sa = scaleOf(c.a.k), sb = scaleOf(c.b.k);
    if (sa !== 'any' && sb !== 'any' && sa !== sb) out.add('scale');
    if (sa === 'any' && sb === 'any') out.add('scale');
    if (c.a.k === c.b.k && c.a.n === c.b.n) out.add('same');
  }
  return [...out];
}

/* ---------- starting points: published strategies written in the same data ---------- */

const P: Term = { k: 'price' };
const T = (k: TermKind, n: number): Term => ({ k, n });
const up = (a: Term, b: Term): Cond => ({ a, op: 'above', b });
const dn = (a: Term, b: Term): Cond => ({ a, op: 'below', b });
/** The built-in rules that this data can express exactly. */
export const TEMPLATES: Partial<Record<RuleId, { buy: Cond[]; sell: Cond[] }>> = {
  trend200: { buy: [up(P, T('sma', 200))], sell: [dn(P, T('sma', 200))] },
  golden: { buy: [up(T('sma', 50), T('sma', 200))], sell: [dn(T('sma', 50), T('sma', 200))] },
  tsmom: { buy: [up(T('ret', 365), T('num', 0))], sell: [dn(T('ret', 365), T('num', 0))] },
  cryptoMom: { buy: [up(T('ret', 28), T('num', 0))], sell: [dn(T('ret', 28), T('num', 0))] },
  break: { buy: [up(P, T('high', 20))], sell: [dn(P, T('low', 10))] },
  turtle2: { buy: [up(P, T('high', 55))], sell: [dn(P, T('low', 20))] },
  donchian: { buy: [up(P, T('high', 20))], sell: [dn(P, T('low', 20))] },
  ma520: { buy: [up(T('sma', 5), T('sma', 20))], sell: [dn(T('sma', 5), T('sma', 20))] },
  triple: { buy: [up(T('sma', 4), T('sma', 9)), up(T('sma', 9), T('sma', 18))], sell: [dn(T('sma', 4), T('sma', 9)), dn(T('sma', 9), T('sma', 18))] },
  rsi2: { buy: [up(P, T('sma', 200)), dn(T('rsi', 2), T('num', 5))], sell: [up(P, T('sma', 5))] },
  rsi: { buy: [dn(T('rsi', 14), T('num', 30))], sell: [up(T('rsi', 14), T('num', 55))] },
  boll: { buy: [dn(P, T('bollLo', 20))], sell: [up(P, T('sma', 20))] },
};
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as RuleId[];
export const fromTemplate = (rule: RuleId) => { const t = TEMPLATES[rule]; return t ? { buy: structuredClone(t.buy), sell: structuredClone(t.sell) } : null; };

/* ---------- what the chart draws for a made rule ---------- */

/** The price-scale lines the rule reads (each once), and the pane it needs for RSI or a return. */
export function specLines(spec: Pick<MadeSpec, 'buy' | 'sell'>, bars: Candle[]): { values: number[]; tone: 'main' | 'fast' | 'up' | 'down' }[] {
  const seen = new Set<string>(), out: { values: number[]; tone: 'main' | 'fast' | 'up' | 'down' }[] = [];
  for (const t of [...spec.buy, ...spec.sell].flatMap((c) => [c.a, c.b])) {
    if (scaleOf(t.k) !== 'price' || t.k === 'price') continue;
    const key = `${t.k}${t.n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ values: series(t, bars), tone: t.k === 'high' || t.k === 'bollUp' ? 'up' : t.k === 'low' || t.k === 'bollLo' ? 'down' : out.some((o) => o.tone === 'main') ? 'fast' : 'main' });
  }
  return out;
}
export function specPane(spec: Pick<MadeSpec, 'buy' | 'sell'>): { kind: 'mom'; days: number } | { kind: 'rsi'; period: number; levels: number[] } | null {
  const conds = [...spec.buy, ...spec.sell];
  const rsi = conds.find((c) => c.a.k === 'rsi' || c.b.k === 'rsi');
  if (rsi) {
    const period = (rsi.a.k === 'rsi' ? rsi.a.n : rsi.b.n) ?? 14;
    return { kind: 'rsi', period, levels: [...new Set(conds.flatMap((c) => (c.a.k === 'rsi' && c.b.k === 'num' ? [c.b.n ?? 0] : c.b.k === 'rsi' && c.a.k === 'num' ? [c.a.n ?? 0] : [])))].sort((x, y) => x - y).slice(0, 2) };
  }
  const ret = conds.find((c) => c.a.k === 'ret' || c.b.k === 'ret');
  return ret ? { kind: 'mom', days: (ret.a.k === 'ret' ? ret.a.n : ret.b.n) ?? 28 } : null;
}

/* ---------- in words ---------- */

export interface Parsed { buy: Cond[]; sell: Cond[]; unknown: string[]; interval?: SpecInterval }
/** "1시간봉으로", "4시간마다", "on hourly candles", "4h": the interval a sentence asks for, if it names one. */
const INTERVAL_WORD = /(?:^|[^\d])([14])\s*(?:시간\s*(?:봉|마다)|h\b|-?\s*hour(?:ly)?\s*(?:candles?|bars?|chart))|(hourly)/i;
export function intervalIn(text: string): SpecInterval | undefined {
  const m = INTERVAL_WORD.exec(text);
  if (!m) return undefined;
  return m[1] === '4' ? '4h' : m[1] === '1' || m[2] ? '1h' : undefined;
}
const BUY_WORD = /(사고|사요|사줘|사자|사서|사라|사는|산다|사\b|매수|진입|들어가|buy|enter|go long)/i;
const SELL_WORD = /(팔아|팔고|팔자|파는|파세|판다|팔\S?|매도|청산|나와|나가|sell|exit|close out)/i;
const ABOVE = /(위|넘|돌파|상회|이상|초과|높|above|over|exceed|greater|cross(?:es)? up)/i;
const BELOW = /(아래|밑|미만|이하|하회|깨|낮|below|under|less|cross(?:es)? down)/i;
const dirOf = (s: string): Cond['op'] | null => { const a = s.search(ABOVE), b = s.search(BELOW); return a < 0 && b < 0 ? null : b < 0 || (a >= 0 && a < b) ? 'above' : 'below'; };
const days = (num: string, unit: string) => Math.round(Number(num) * (/주|week/i.test(unit) ? 7 : /개월|달|month/i.test(unit) ? 30 : /년|year/i.test(unit) ? 365 : 1));

/** The conditions in one clause ("above the 200-day average and RSI under 30"). `last` is the thing the clause before was about. */
function conds(clause: string, last: Term | null): { found: Cond[]; last: Term | null } {
  const hits: { c: Cond; at: number }[] = [];
  let rest = clause;
  const take = (re: RegExp, make: (m: RegExpExecArray, tail: string) => Cond | null) => {
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      const tail = rest.slice(m.index + m[0].length, m.index + m[0].length + 24);
      const c = make(m, tail);
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
      if (c) hits.push({ c, at: m.index });
      re.lastIndex = 0;
      if (!c) break;
    }
  };
  // crosses
  take(/골든\s*크로스|golden cross/i, () => up(T('sma', 50), T('sma', 200)));
  take(/데드\s*크로스|death cross/i, () => dn(T('sma', 50), T('sma', 200)));
  // RSI(n) against a level
  take(/rsi\s*\(?\s*(\d+)?\s*\)?[^\d]{0,12}?(\d+(?:\.\d+)?)/i, (m, tail) => { const d = dirOf(tail) ?? dirOf(m[0]); return d ? { a: T('rsi', Number(m[1] ?? 14)), op: d, b: T('num', Number(m[2])) } : null; });
  // a new n-day high / low
  take(/(\d+)\s*(일|주|개월|달|-?\s*day|-?\s*week|-?\s*month)s?\s*(신?고가|최고가|고점|high)/i, (m) => up(P, T('high', days(m[1], m[2]))));
  take(/(\d+)\s*(일|주|개월|달|-?\s*day|-?\s*week|-?\s*month)s?\s*(신?저가|최저가|저점|low)/i, (m) => dn(P, T('low', days(m[1], m[2]))));
  // price against an average
  take(/(\d+)\s*(일|주|-?\s*day|-?\s*week)s?\s*(지수\s*이동\s*평균|ema|exponential (?:moving )?average)(?:선)?/i, (m, tail) => { const d = dirOf(tail) ?? dirOf(clause); return d ? { a: P, op: d, b: T('ema', days(m[1], m[2])) } : null; });
  take(/(\d+)\s*(일|주|-?\s*day|-?\s*week)s?\s*(이동\s*평균|이평|평균|선|ma\b|sma|(?:simple )?(?:moving )?average)(?:선)?/i, (m, tail) => { const d = dirOf(tail) ?? dirOf(clause); return d ? { a: P, op: d, b: T('sma', days(m[1], m[2])) } : null; });
  // a return over some time
  take(/(\d+)\s*(일|주|개월|달|년|-?\s*day|-?\s*week|-?\s*month|-?\s*year)s?\s*(전보다|수익률|동안|간|ago|return)/i, (m, tail) => {
    const s = tail + m[0];
    const d = /(높|올랐|오르|플러스|양수|상승|higher|up|positive|gain)/i.test(s) ? 'above' : /(낮|내렸|내리|떨어|마이너스|음수|하락|lower|down|negative|loss)/i.test(s) ? 'below' : dirOf(tail);
    return d ? { a: T('ret', days(m[1], m[2])), op: d, b: T('num', 0) } : null;
  });
  // In the order they were said.
  const found = hits.sort((x, y) => x.at - y.at).map((h) => h.c);
  if (found.length) { const c = found[found.length - 1]; last = c.a.k === 'price' ? c.b : c.a; }
  // "…and above 50 it sells": a bare level, about whatever the clause before was reading
  if (!found.length && last && (last.k === 'rsi' || last.k === 'ret')) {
    const m = /(-?\d+(?:\.\d+)?)/.exec(rest), d = dirOf(rest);
    if (m && d) { found.push({ a: last, op: d, b: T('num', Number(m[1])) }); rest = rest.replace(m[0], ' '); }
  }
  // "…and sells below it": the same line as before, the other way
  if (!found.length && last && scaleOf(last.k) === 'price') { const d = dirOf(rest); if (d) found.push({ a: P, op: d, b: last }); }
  return { found, last };
}

/**
 * Read a rule from a sentence: "buy above the 200-day average when RSI is under 30, sell when RSI is over 55",
 * "200일선 위에서 RSI가 30 밑이면 사고 55 넘으면 팔아". What it could not read comes back in `unknown`.
 */
export function parse(text: string): Parsed {
  const out: Parsed = { buy: [], sell: [], unknown: [] };
  const iv = intervalIn(text);
  if (iv) out.interval = iv;
  // Cut the sentence where it says "buy" or "sell": each piece ends with its action (Korean) or starts with it (English).
  const marks: { at: number; end: number; side: 'buy' | 'sell' }[] = [];
  for (const [re, side] of [[BUY_WORD, 'buy'], [SELL_WORD, 'sell']] as const) {
    const g = new RegExp(re.source, 'gi');
    for (let m = g.exec(text); m; m = g.exec(text)) marks.push({ at: m.index, end: m.index + m[0].length, side });
  }
  marks.sort((a, b) => a.at - b.at);
  if (!marks.length) { const c = conds(text, null); out.buy = c.found; if (!c.found.length && text.trim()) out.unknown.push(text.trim()); return out; }
  const english = /^[\s\w.,%()'’-]+$/.test(text) && /[a-z]/i.test(text);
  let last: Term | null = null, from = 0;
  marks.forEach((mk, i) => {
    // Korean puts the condition before the verb ("…이면 사고"); English after it ("buy when …").
    const clause = english ? text.slice(mk.end, marks[i + 1]?.at ?? text.length) : text.slice(from, mk.at);
    from = mk.end;
    const c = conds(clause, last);
    last = c.last;
    if (c.found.length) out[mk.side].push(...c.found); else if (clause.replace(/[\s,.·고면서]/g, '').length > 3) out.unknown.push(clause.trim());
  });
  out.buy = out.buy.slice(0, MAX_CONDS); out.sell = out.sell.slice(0, MAX_CONDS);
  return out;
}
