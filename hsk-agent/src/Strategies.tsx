// Strategy picks under the chart. CEX and DEX get different sets:
//  - CEX (HashKey Global BTC perpetual): position rules (trend, breakout, RSI bounce, futures mood, ATR stop),
//    backtested on the perpetual's own daily candles.
//  - DEX (HSKSwap spot): ways to collect a coin (pool discount, smart DCA, trend DCA, RSI-weighted DCA, ATR stop),
//    backtested on Gate daily candles because the pools have too few swaps for history.
// Tapping a tile sends a full strategy card to Moa on the right. Every number comes from live data;
// a rule without history says "live signal" instead of inventing a backtest. No fees are modelled.
import { useEffect, useState } from 'react';
import type { Asset } from './intent.ts';
import { ASSETS } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import * as cex from './cex.ts';
import { gateCandles } from './gate.ts';
import * as I from './indicators.ts';

export type Signal = 'good' | 'neutral' | 'wait';
export type Venue = 'cex' | 'dex';
type Bar = cex.Candle;

/** Everything Moa needs to show a strategy card on the right. */
export interface StratNote {
  n: number; venue: Venue; name: string; signal: Signal; value: string; valueLabel: string; good: boolean;
  facts: [string, string, string?][]; rules: string[]; text: string; source: string;
  spark?: { closes: number[]; ref?: number[]; refLabel?: string; level?: number; levelLabel?: string; dots?: number[] };
  follow: string[];
}

const cache = new Map<string, Promise<Bar[]>>();
function daily(venue: Venue, asset: Asset): Promise<Bar[]> {
  const k = venue === 'cex' ? 'cex' : asset;
  if (!cache.has(k)) {
    const p = venue === 'cex' ? cex.klines('1d', 400) : gateCandles(asset, '1d', 400);
    cache.set(k, p.catch((e: unknown) => { cache.delete(k); throw e; }));
  }
  return cache.get(k)!;
}

const pct = (v: number, d = 1) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const BT = 180;   // position backtests: last 180 days
const N = 90, BASE = 10; // DCA backtests: $10/day for 90 days

/** Long-only backtest: pos[i] (decided at close i) earns the return from i to i+1. */
function runPos(closes: number[], pos: boolean[], from: number) {
  let eq = 1, trades = 0, days = 0;
  const dots: number[] = [];
  for (let i = from; i < closes.length - 1; i++) {
    if (pos[i] && !pos[i - 1]) { trades++; dots.push(i); }
    if (pos[i]) { eq *= closes[i + 1] / closes[i]; days++; }
  }
  return { ret: eq - 1, hold: closes[closes.length - 1] / closes[from] - 1, trades, inMkt: days / (closes.length - 1 - from), dots };
}

function trendPos(c: number[]) {
  const ma = I.sma(c, 50);
  return c.map((x, i) => Number.isFinite(ma[i]) && x > ma[i]);
}
function breakoutPos(bars: Bar[]) {
  const pos: boolean[] = []; let on = false;
  for (let i = 0; i < bars.length; i++) {
    if (i < 21) { pos.push(false); continue; }
    const hi = Math.max(...bars.slice(i - 20, i).map((b) => b.high));
    const lo = Math.min(...bars.slice(i - 10, i).map((b) => b.low));
    if (!on && bars[i].close > hi) on = true; else if (on && bars[i].close < lo) on = false;
    pos.push(on);
  }
  return pos;
}
function rsiPos(c: number[]) {
  const r = I.rsi(c); const pos: boolean[] = []; let on = false;
  for (let i = 0; i < c.length; i++) {
    if (!on && r[i] < 30) on = true; else if (on && r[i] > 55) on = false;
    pos.push(on);
  }
  return pos;
}

/** DCA average cost over the last N days with a per-day multiplier; compared with plain $10/day. */
function dca(c: number[], mult: (i: number) => number) {
  let s = 0, q = 0, ps = 0, pq = 0, skipped = 0;
  const dots: number[] = [];
  for (let i = c.length - N; i < c.length; i++) {
    const m = mult(i);
    ps += BASE; pq += BASE / c[i];
    if (m <= 0) { skipped++; continue; }
    s += BASE * m; q += BASE * m / c[i];
    if (m >= 1.5) dots.push(i);
  }
  return { better: q > 0 ? s / q / (ps / pq) - 1 : undefined, avg: q > 0 ? s / q : undefined, plain: ps / pq, skipped, dots };
}

interface Tile { id: string; note: Omit<StratNote, 'n' | 'follow'>; line: string; caption: string; prompt: string }

export default function StrategyGrid({ venue, quotes, mark, index, tape, onPick, asset: extAsset, setAsset: setExtAsset }: {
  venue: Venue; quotes: Quote[]; mark?: number; index?: number; tape?: cex.Trade[]; onPick: (note: StratNote) => void;
  asset?: Asset; setAsset?: (a: Asset) => void;
}) {
  const { t } = useT();
  const [ownAsset, setOwnAsset] = useState<Asset>('ETH');
  const asset: Asset = venue === 'cex' ? 'BTC' : extAsset ?? ownAsset;
  const setAsset = setExtAsset ?? setOwnAsset;
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    let alive = true;
    setBars(null); setFailed(false); setPicked(null);
    daily(venue, asset).then((d) => alive && setBars(d), () => alive && setFailed(true));
    return () => { alive = false; };
  }, [venue, asset]);

  const wait = failed ? '—' : '…';
  const c = bars?.map((b) => b.close) ?? [];
  const last = c[c.length - 1];
  const tail = (xs: number[]) => xs.slice(-N);
  const shift = (dots: number[]) => dots.map((i) => i - (c.length - N)).filter((i) => i >= 0);
  const enough = (k: number) => !!bars && bars.length >= k;
  const src = venue === 'cex' ? t.srcHk : t.srcGate(asset);
  const atrV = bars ? I.atr(bars) : null;
  const atrTile = (prompt: string): Tile => {
    const dist = atrV && last ? (2 * atrV) / last : undefined;
    const stop = atrV && last ? last - 2 * atrV : undefined;
    const lev = dist ? Math.max(1, Math.floor(0.8 / dist)) : undefined;
    return {
      id: 'atr', line: t.lAtr, caption: stop ? t.capStopAt(fmtPrice(stop)) : t.capAtr, prompt,
      note: {
        venue, name: t.sAtrName, signal: 'neutral', value: dist ? pct(-dist) : wait, valueLabel: t.capAtr, good: false, source: src,
        facts: [[t.fNow, last ? `$${fmtPrice(last)}` : '—'], [t.fStop, stop ? `$${fmtPrice(stop)}` : '—'], venue === 'cex' ? [t.fLev, lev ? `≤ ${lev}×` : '—', t.fLevHint] : [t.fAtr, atrV && last ? pct(atrV / last) : '—']],
        rules: venue === 'cex' ? t.rAtrCex : t.rAtrDex,
        text: stop && dist && atrV ? (venue === 'cex' ? t.xAtrCex(fmtPrice(stop), pct(-dist), pct(atrV / last), String(lev)) : t.xAtr(asset, fmtPrice(stop), pct(-dist), pct(atrV / last))) : t.xNoData,
        spark: bars ? { closes: tail(c), level: stop, levelLabel: t.fStop } : undefined,
      },
    };
  };

  let tiles: Tile[];
  if (venue === 'cex') {
    const ok = enough(BT + 60);
    const from = c.length - 1 - BT;
    const tr = ok ? runPos(c, trendPos(c), from) : null;
    const bo = ok ? runPos(c, breakoutPos(bars!), from) : null;
    const rp = ok ? rsiPos(c) : null;
    const rs = ok ? runPos(c, rp!, from) : null;
    const ma50 = ok ? I.sma(c, 50) : [];
    const rsiNow = ok ? I.rsi(c)[c.length - 1] : undefined;
    const hi20 = ok ? Math.max(...bars!.slice(-21, -1).map((b) => b.high)) : undefined;
    const trOn = ok && last > ma50[ma50.length - 1];
    const boOn = ok && breakoutPos(bars!)[c.length - 1];
    const rsOn = !!rp && rp[c.length - 1];
    const basis = mark !== undefined && index ? mark / index - 1 : undefined;
    const buy = tape?.length ? tape.filter((x) => !x.buyerIsMaker).length / tape.length : undefined;
    const posFacts = (r: { trades: number; inMkt: number }): [string, string][] => [[t.fTrades, String(r.trades)], [t.fInMkt, `${Math.round(r.inMkt * 100)}%`]];
    const edge = (r: { ret: number } | null) => (r ? pct(r.ret) : wait);
    const cap = (r: { hold: number } | null) => (r ? t.capRet(BT, pct(r.hold)) : t.capRet(BT, '…'));
    tiles = [
      {
        id: 'trend', line: t.cTrendLine, caption: cap(tr), prompt: t.pcTrend,
        note: {
          venue, name: t.cTrendName, signal: !tr ? 'neutral' : trOn ? 'good' : 'wait', value: edge(tr), valueLabel: cap(tr), good: !!tr && tr.ret > tr.hold, source: src,
          facts: tr ? [...posFacts(tr), [t.fNow, trOn ? t.inPos : t.flat]] : [], rules: t.rcTrend,
          text: tr ? t.xcTrend(pct(tr.ret), pct(tr.hold), tr.trades, trOn, pct(last / ma50[ma50.length - 1] - 1)) : t.xNoData,
          spark: tr ? { closes: tail(c), ref: tail(ma50), refLabel: 'MA50', dots: shift(tr.dots) } : undefined,
        },
      },
      {
        id: 'break', line: t.cBreakLine, caption: cap(bo), prompt: t.pcBreak,
        note: {
          venue, name: t.cBreakName, signal: !bo ? 'neutral' : boOn ? 'good' : 'neutral', value: edge(bo), valueLabel: cap(bo), good: !!bo && bo.ret > bo.hold, source: src,
          facts: bo ? [...posFacts(bo), [t.fHigh20, hi20 ? `$${fmtPrice(hi20)}` : '—']] : [], rules: t.rcBreak,
          text: bo && hi20 ? t.xcBreak(pct(bo.ret), pct(bo.hold), bo.trades, !!boOn, fmtPrice(hi20), pct(hi20 / last - 1)) : t.xNoData,
          spark: bo && hi20 ? { closes: tail(c), level: hi20, levelLabel: t.fHigh20, dots: shift(bo.dots) } : undefined,
        },
      },
      {
        id: 'rsi', line: t.cRsiLine, caption: cap(rs), prompt: t.pcRsi,
        note: {
          venue, name: t.cRsiName, signal: rsiNow === undefined ? 'neutral' : rsiNow < 35 ? 'good' : rsiNow > 70 ? 'wait' : 'neutral', value: edge(rs), valueLabel: cap(rs), good: !!rs && rs.ret > rs.hold, source: src,
          facts: rs && rsiNow !== undefined ? [...posFacts(rs), [t.fRsi, rsiNow.toFixed(0)]] : [], rules: t.rcRsi,
          text: rs && rsiNow !== undefined ? t.xcRsi(pct(rs.ret), pct(rs.hold), rs.trades, rsiNow.toFixed(0), rsOn) : t.xNoData,
          spark: rs ? { closes: tail(c), dots: shift(rs.dots) } : undefined,
        },
      },
      {
        id: 'mood', line: t.l3, caption: t.capLiveBasis, prompt: t.s3Prompt,
        note: {
          venue, name: t.s3Name, signal: basis === undefined ? 'neutral' : basis <= -0.0005 ? 'good' : basis >= 0.0008 ? 'wait' : 'neutral', value: basis === undefined ? '—' : pct(basis, 3), valueLabel: t.capLiveBasis, good: basis !== undefined && basis < 0, source: t.srcLive,
          facts: [[t.mark, mark ? `$${fmtPrice(mark)}` : '—'], [t.index, index ? `$${fmtPrice(index)}` : '—'], [t.fBuyers, buy === undefined ? '—' : `${Math.round(buy * 100)}%`]], rules: t.rcMood,
          text: basis === undefined ? t.xNoData : t.x3(pct(basis, 3), buy === undefined ? '—' : `${Math.round(buy * 100)}%`),
        },
      },
      atrTile(t.pcAtr),
    ];
  } else {
    const q = quotes.find((x) => x.asset === asset);
    const gap = q?.gap;
    const ok = enough(N + 51);
    const ma20 = ok ? I.sma(c, 20) : [], ma50 = ok ? I.sma(c, 50) : [], r = ok ? I.rsi(c) : [];
    // Decisions use yesterday's indicators (i - 1) so the backtest never peeks at today's close.
    const sm = ok ? dca(c, (i) => Math.min(2, Math.max(0.5, ma20[i - 1] / c[i]))) : null;
    const tr = ok ? dca(c, (i) => (c[i] > ma50[i - 1] ? 1 : 0)) : null;
    const rd = ok ? dca(c, (i) => (r[i - 1] < 35 ? 2 : r[i - 1] > 65 ? 0.5 : 1)) : null;
    const vs20 = ok ? last / ma20[ma20.length - 1] - 1 : 0, vs50 = ok ? last / ma50[ma50.length - 1] - 1 : 0;
    const multNow = ok ? Math.min(2, Math.max(0.5, ma20[ma20.length - 1] / last)) : 1;
    const rNow = ok ? r[r.length - 1] : undefined;
    const rMult = rNow === undefined ? 1 : rNow < 35 ? 2 : rNow > 65 ? 0.5 : 1;
    const dcaFacts = (d: { avg?: number; plain: number }, extra: [string, string]): [string, string][] => [[t.fAvg, d.avg ? `$${fmtPrice(d.avg)}` : '—'], [t.fPlain, `$${fmtPrice(d.plain)}`], extra];
    tiles = [
      {
        id: 'discount', line: t.l1, caption: t.capLiveGap, prompt: t.s1Prompt(asset),
        note: {
          venue, name: t.s1Name, signal: gap === undefined ? 'neutral' : gap <= -0.003 ? 'good' : gap >= 0.003 ? 'wait' : 'neutral', value: gap === undefined ? '—' : pct(gap, 2), valueLabel: t.capLiveGap, good: gap !== undefined && gap < 0, source: t.srcLive,
          facts: [[t.fPool, q?.pool !== undefined ? `$${fmtPrice(q.pool)}` : '—'], [t.fGate, q?.exchange !== undefined ? `$${fmtPrice(q.exchange)}` : '—'], [t.fGap, gap === undefined ? '—' : pct(gap, 2)]], rules: t.rDiscount(asset),
          text: gap === undefined ? t.xNoData : t.x1(asset, q?.pool !== undefined ? fmtPrice(q.pool) : '—', q?.exchange !== undefined ? fmtPrice(q.exchange) : '—', pct(gap, 2)),
        },
      },
      {
        id: 'smart', line: t.l2, caption: t.cap90(asset), prompt: t.s2Prompt(asset),
        note: {
          venue, name: t.s2Name, signal: !sm ? 'neutral' : vs20 <= -0.02 ? 'good' : vs20 >= 0.05 ? 'wait' : 'neutral', value: sm?.better !== undefined ? pct(sm.better, 2) : wait, valueLabel: t.cap90(asset), good: !!sm && (sm.better ?? 0) < 0, source: src,
          facts: sm ? dcaFacts(sm, [t.fMult, `×${multNow.toFixed(2)}`]) : [], rules: t.rSmart,
          text: sm?.better !== undefined ? t.x2(asset, pct(sm.better, 2), pct(vs20), multNow.toFixed(2)) : t.xNoData,
          spark: sm ? { closes: tail(c), ref: tail(ma20), refLabel: 'MA20', dots: shift(sm.dots) } : undefined,
        },
      },
      {
        id: 'trend', line: t.lTrend, caption: tr ? t.capSkipped(tr.skipped) : t.cap90(asset), prompt: t.pTrend(asset),
        note: {
          venue, name: t.sTrendName, signal: !tr ? 'neutral' : vs50 > 0 ? 'good' : 'wait', value: tr?.better !== undefined ? pct(tr.better, 2) : wait, valueLabel: t.cap90(asset), good: !!tr && (tr.better ?? 0) < 0, source: src,
          facts: tr ? dcaFacts(tr, [t.fSkipped, `${tr.skipped} / ${N}`]) : [], rules: t.rTrend,
          text: tr ? t.xTrend(asset, tr.better !== undefined ? pct(tr.better, 2) : '—', tr.skipped, vs50 > 0, pct(vs50)) : t.xNoData,
          spark: tr ? { closes: tail(c), ref: tail(ma50), refLabel: 'MA50' } : undefined,
        },
      },
      {
        id: 'rsidca', line: t.dRsiLine, caption: t.cap90(asset), prompt: t.pdRsi(asset),
        note: {
          venue, name: t.dRsiName, signal: rNow === undefined ? 'neutral' : rNow < 35 ? 'good' : rNow > 65 ? 'wait' : 'neutral', value: rd?.better !== undefined ? pct(rd.better, 2) : wait, valueLabel: t.cap90(asset), good: !!rd && (rd.better ?? 0) < 0, source: src,
          facts: rd && rNow !== undefined ? dcaFacts(rd, [t.fRsi, `${rNow.toFixed(0)} → ×${rMult}`]) : [], rules: t.rRsiDca,
          text: rd?.better !== undefined && rNow !== undefined ? t.xdRsi(asset, pct(rd.better, 2), rNow.toFixed(0), String(rMult)) : t.xNoData,
          spark: rd ? { closes: tail(c), dots: shift(rd.dots) } : undefined,
        },
      },
      atrTile(t.pAtr(asset, atrV && last ? `${Math.round((2 * atrV / last) * 100)}%` : '10%')),
    ];
  }

  const rank = (s: Signal) => (s === 'good' ? 2 : s === 'neutral' ? 1 : 0);
  const best = [...tiles].sort((a, b) => rank(b.note.signal) - rank(a.note.signal))[0];

  const pick = (x: Tile) => {
    setPicked(x.id);
    const next = n + 1; setN(next);
    onPick({ ...x.note, n: next, follow: [x.prompt, t.fuRisk(x.note.name)] });
  };

  return (
    <section className="strats" aria-label={venue === 'cex' ? t.stratTitleCex : t.stratTitleDex}>
      <div className="strats-head">
        <div>
          <h3>{venue === 'cex' ? t.stratTitleCex : t.stratTitleDex}</h3>
          <p className="muted">{venue === 'cex' ? t.stratHintCex : t.stratHintDex}</p>
        </div>
        {venue === 'dex' && (
          <div className="coin-switch" role="tablist" aria-label={t.stratAsset}>
            {ASSETS.map((a) => <button key={a} role="tab" aria-selected={a === asset} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}>{a}</button>)}
          </div>
        )}
      </div>
      <div className="strat-tiles">
        {tiles.map((x) => (
          <button key={x.id} className={`tile${picked === x.id ? ' on' : ''}`} onClick={() => pick(x)} aria-pressed={picked === x.id}>
            <span className="tile-top">
              <b>{x.note.name}</b>
              <span className={`sig sig-${x.note.signal}`}>{t.sig[x.note.signal]}</span>
            </span>
            <span className="tile-line">{x.line}</span>
            <span className="tile-num">
              <strong className={x.note.good ? 'pos' : ''}>{x.note.value}</strong>
              <small>{x.caption}</small>
            </span>
            {x.id === best.id && rank(best.note.signal) === 2 && <span className="tile-best">{t.stratRec}</span>}
          </button>
        ))}
      </div>
      <p className="strats-foot muted">{venue === 'cex' ? t.stratFootCex : t.stratFootDex}</p>
    </section>
  );
}
