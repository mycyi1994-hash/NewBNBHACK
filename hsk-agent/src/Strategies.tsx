// Strategy picks under the chart: five tiles, each with its rule, one key number and a live signal.
// Clicking a tile makes Moa (right panel) explain that strategy with today's numbers and offer to plan it.
// Every number is computed from live data (Gate daily candles, HSKSwap pools, HashKey perpetual);
// a strategy without history says "live signal" instead of inventing a backtest.
import { useEffect, useState } from 'react';
import type { Asset } from './intent.ts';
import { ASSETS } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import type { Trade } from './cex.ts';

type Signal = 'good' | 'neutral' | 'wait';
export type StratId = 'smart' | 'trend' | 'discount' | 'mood' | 'atr';
export interface StratNote { n: number; text: string; follow: string[] }
interface Daily { time: number; close: number; high: number; low: number }

const PAIR: Record<Asset, string> = { HSK: 'HSK_USDT', ETH: 'ETH_USDT', BTC: 'BTC_USDT' };
const cache = new Map<Asset, Promise<Daily[]>>();

/** Gate daily candles, oldest first. Row: [time, quote volume, close, high, low, open, base volume, closed]. */
function gateDaily(asset: Asset): Promise<Daily[]> {
  if (!cache.has(asset)) {
    cache.set(asset, fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${PAIR[asset]}&interval=1d&limit=170`)
      .then((r) => { if (!r.ok) throw new Error(`Gate HTTP ${r.status}`); return r.json() as Promise<string[][]>; })
      .then((rows) => rows.map((r) => ({ time: Number(r[0]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]) })).filter((d) => d.close > 0))
      .catch((e: unknown) => { cache.delete(asset); throw e; }));
  }
  return cache.get(asset)!;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (v: number, d = 2) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const N = 90, BASE = 10;

/** Plain DCA ($10 every day for 90 days): average cost. */
function plainAvg(days: Daily[]) {
  let s = 0, c = 0;
  for (let i = days.length - N; i < days.length; i++) { s += BASE; c += BASE / days[i].close; }
  return s / c;
}

/** Smart DCA: $10 × (20-day average / price), clamped to ×0.5…×2. */
function smartDca(days: Daily[]) {
  if (days.length < N + 21) return null;
  let s = 0, c = 0;
  for (let i = days.length - N; i < days.length; i++) {
    const amt = BASE * clamp(avg(days.slice(i - 20, i).map((d) => d.close)) / days[i].close, 0.5, 2);
    s += amt; c += amt / days[i].close;
  }
  const ma20 = avg(days.slice(-21, -1).map((d) => d.close));
  const last = days[days.length - 1].close;
  return { better: s / c / plainAvg(days) - 1, vsMa: last / ma20 - 1, mult: clamp(ma20 / last, 0.5, 2) };
}

/** Trend filter: buy $10 only on days the price is above its 50-day average. */
function trendDca(days: Daily[]) {
  if (days.length < N + 51) return null;
  let s = 0, c = 0, skipped = 0;
  for (let i = days.length - N; i < days.length; i++) {
    const ma50 = avg(days.slice(i - 50, i).map((d) => d.close));
    if (days[i].close > ma50) { s += BASE; c += BASE / days[i].close; } else skipped++;
  }
  const ma50 = avg(days.slice(-51, -1).map((d) => d.close));
  const last = days[days.length - 1].close;
  return { better: c > 0 ? s / c / plainAvg(days) - 1 : undefined, skipped, above: last > ma50, vsMa: last / ma50 - 1 };
}

/** Volatility stop: 2 × ATR(14) below the last close. */
function atrStop(days: Daily[]) {
  if (days.length < 16) return null;
  const tr: number[] = [];
  for (let i = days.length - 14; i < days.length; i++) {
    const d = days[i], p = days[i - 1].close;
    tr.push(Math.max(d.high - d.low, Math.abs(d.high - p), Math.abs(d.low - p)));
  }
  const atr = avg(tr), last = days[days.length - 1].close;
  return { stop: last - 2 * atr, dist: -(2 * atr) / last, atrPct: atr / last };
}

export default function StrategyGrid({ quotes, mark, index, tape, onPick }: {
  quotes: Quote[]; mark?: number; index?: number; tape: Trade[]; onPick: (note: StratNote) => void;
}) {
  const { t } = useT();
  const [asset, setAsset] = useState<Asset>('ETH');
  const [days, setDays] = useState<Daily[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<StratId | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    let alive = true;
    setDays(null); setFailed(false);
    gateDaily(asset).then((d) => alive && setDays(d), () => alive && setFailed(true));
    return () => { alive = false; };
  }, [asset]);

  const sm = days ? smartDca(days) : null;
  const tr = days ? trendDca(days) : null;
  const at = days ? atrStop(days) : null;
  const q = quotes.find((x) => x.asset === asset);
  const gap = q?.gap;
  const basis = mark !== undefined && index ? mark / index - 1 : undefined;
  const buyShare = tape.length ? tape.filter((x) => !x.buyerIsMaker).length / tape.length : undefined;
  const waiting = failed ? '—' : '…';

  const tiles: { id: StratId; name: string; line: string; value: string; good: boolean; caption: string; signal: Signal; explain: string; prompt: string }[] = [
    {
      id: 'smart', name: t.s2Name, line: t.l2,
      value: sm ? pct(sm.better) : waiting, good: !!sm && sm.better < 0, caption: t.cap90(asset),
      signal: !sm ? 'neutral' : sm.vsMa <= -0.02 ? 'good' : sm.vsMa >= 0.05 ? 'wait' : 'neutral',
      explain: sm ? t.x2(asset, pct(sm.better), pct(sm.vsMa, 1), sm.mult.toFixed(2)) : t.xNoData,
      prompt: t.s2Prompt(asset),
    },
    {
      id: 'trend', name: t.sTrendName, line: t.lTrend,
      value: tr && tr.better !== undefined ? pct(tr.better) : waiting, good: !!tr && tr.better !== undefined && tr.better < 0,
      caption: tr ? t.capSkipped(tr.skipped) : t.cap90(asset),
      signal: !tr ? 'neutral' : tr.above ? 'good' : 'wait',
      explain: tr ? t.xTrend(asset, tr.better !== undefined ? pct(tr.better) : '—', tr.skipped, tr.above, pct(tr.vsMa, 1)) : t.xNoData,
      prompt: t.pTrend(asset),
    },
    {
      id: 'discount', name: t.s1Name, line: t.l1,
      value: gap === undefined ? '—' : pct(gap), good: gap !== undefined && gap < 0, caption: t.capLiveGap,
      signal: gap === undefined ? 'neutral' : gap <= -0.003 ? 'good' : gap >= 0.003 ? 'wait' : 'neutral',
      explain: gap === undefined ? t.xNoData : t.x1(asset, q?.pool !== undefined ? fmtPrice(q.pool) : '—', q?.exchange !== undefined ? fmtPrice(q.exchange) : '—', pct(gap)),
      prompt: t.s1Prompt(asset),
    },
    {
      id: 'mood', name: t.s3Name, line: t.l3,
      value: basis === undefined ? '—' : pct(basis, 3), good: basis !== undefined && basis < 0, caption: t.capLiveBasis,
      signal: basis === undefined ? 'neutral' : basis <= -0.0005 ? 'good' : basis >= 0.0008 ? 'wait' : 'neutral',
      explain: basis === undefined ? t.xNoData : t.x3(pct(basis, 3), buyShare === undefined ? '—' : `${Math.round(buyShare * 100)}%`),
      prompt: t.s3Prompt,
    },
    {
      id: 'atr', name: t.sAtrName, line: t.lAtr,
      value: at ? pct(at.dist, 1) : waiting, good: false, caption: at ? t.capStopAt(fmtPrice(at.stop)) : t.capAtr,
      signal: 'neutral',
      explain: at ? t.xAtr(asset, fmtPrice(at.stop), pct(at.dist, 1), pct(at.atrPct, 1)) : t.xNoData,
      prompt: t.pAtr(asset, at ? `${Math.round(-at.dist * 100)}%` : '10%'),
    },
  ];
  const rank = (s: Signal) => (s === 'good' ? 2 : s === 'neutral' ? 1 : 0);
  const best = [...tiles].sort((a, b) => rank(b.signal) - rank(a.signal))[0];

  const pick = (id: StratId) => {
    const tile = tiles.find((x) => x.id === id)!;
    setPicked(id);
    const next = n + 1; setN(next);
    onPick({ n: next, text: `${tile.name} · ${tile.explain}`, follow: [tile.prompt, t.fuRisk(tile.name)] });
  };

  return (
    <section className="strats" aria-label={t.stratTitle}>
      <div className="strats-head">
        <div>
          <h3>{t.stratTitle}</h3>
          <p className="muted">{t.stratHint}</p>
        </div>
        <div className="coin-switch" role="tablist" aria-label={t.stratAsset}>
          {ASSETS.map((a) => <button key={a} role="tab" aria-selected={a === asset} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}>{a}</button>)}
        </div>
      </div>
      <div className="strat-tiles">
        {tiles.map((x) => (
          <button key={x.id} className={`tile${picked === x.id ? ' on' : ''}`} onClick={() => pick(x.id)} aria-pressed={picked === x.id}>
            <span className="tile-top">
              <b>{x.name}</b>
              <span className={`sig sig-${x.signal}`}>{t.sig[x.signal]}</span>
            </span>
            <span className="tile-line">{x.line}</span>
            <span className="tile-num">
              <strong className={x.good ? 'pos' : ''}>{x.value}</strong>
              <small>{x.caption}</small>
            </span>
            {x.id === best.id && rank(best.signal) === 2 && <span className="tile-best">{t.stratRec}</span>}
          </button>
        ))}
      </div>
      <p className="strats-foot muted">{t.stratFoot}</p>
    </section>
  );
}
