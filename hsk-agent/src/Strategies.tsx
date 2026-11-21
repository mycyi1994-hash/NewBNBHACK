// Moa strategy picks under the chart. Rules are plain arithmetic on live data; nothing here is a model guess.
// - HSKSwap discount buy: live pool price vs Gate (no history for the pool, so no backtest).
// - Smart DCA: buy more below the 20-day average, less above; backtested on 90 days of Gate daily candles.
// - Futures mood: HashKey perp mark vs index and the taker buy share of recent trades (live only).
import { useEffect, useState } from 'react';
import type { Asset } from './intent.ts';
import { ASSETS } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import type { Trade } from './cex.ts';

type Signal = 'good' | 'neutral' | 'wait';
interface Daily { time: number; close: number }

const PAIR: Record<Asset, string> = { HSK: 'HSK_USDT', ETH: 'ETH_USDT', BTC: 'BTC_USDT' };
const cache = new Map<Asset, Promise<Daily[]>>();

/** Gate daily candles, oldest first. Row: [time, quote volume, close, high, low, open, base volume, closed]. */
function gateDaily(asset: Asset): Promise<Daily[]> {
  if (!cache.has(asset)) {
    cache.set(asset, fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${PAIR[asset]}&interval=1d&limit=120`)
      .then((r) => { if (!r.ok) throw new Error(`Gate HTTP ${r.status}`); return r.json() as Promise<string[][]>; })
      .then((rows) => rows.map((r) => ({ time: Number(r[0]), close: Number(r[2]) })).filter((d) => d.close > 0))
      .catch((e: unknown) => { cache.delete(asset); throw e; }));
  }
  return cache.get(asset)!;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** $10 a day for the last 90 days: plain DCA vs "more below the 20-day average" (×0.5 … ×2). */
function backtest(days: Daily[]) {
  const n = 90, base = 10;
  if (days.length < n + 20) return null;
  let pSpent = 0, pCoins = 0, sSpent = 0, sCoins = 0;
  for (let i = days.length - n; i < days.length; i++) {
    const px = days[i].close;
    const ma = avg(days.slice(i - 20, i).map((d) => d.close));
    pSpent += base; pCoins += base / px;
    const amt = base * clamp(ma / px, 0.5, 2);
    sSpent += amt; sCoins += amt / px;
  }
  const pAvg = pSpent / pCoins, sAvg = sSpent / sCoins;
  const last = days[days.length - 1].close;
  const ma20 = avg(days.slice(-21, -1).map((d) => d.close)); // previous 20 days, same as the backtest
  return { pAvg, sAvg, better: sAvg / pAvg - 1, sSpent, pSpent, mult: clamp(ma20 / last, 0.5, 2), vsMa: last / ma20 - 1, from: days[days.length - n].time };
}

export default function Strategies({ quotes, mark, index, tape, onAsk }: {
  quotes: Quote[]; mark?: number; index?: number; tape: Trade[]; onAsk: (prompt: string) => void;
}) {
  const { t } = useT();
  const [asset, setAsset] = useState<Asset>('HSK');
  const [days, setDays] = useState<Daily[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDays(null); setErr(null);
    gateDaily(asset).then((d) => alive && setDays(d), (e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [asset]);

  // 1. discount buy (live)
  const q = quotes.find((x) => x.asset === asset);
  const gap = q?.gap;
  const s1: Signal = gap === undefined ? 'neutral' : gap <= -0.003 ? 'good' : gap >= 0.003 ? 'wait' : 'neutral';
  // 2. smart DCA (backtest + today's multiplier)
  const bt = days ? backtest(days) : null;
  const s2: Signal = !bt ? 'neutral' : bt.vsMa <= -0.02 ? 'good' : bt.vsMa >= 0.05 ? 'wait' : 'neutral';
  // 3. futures mood (BTC perp)
  const basis = mark !== undefined && index ? mark / index - 1 : undefined;
  const buyShare = tape.length ? tape.filter((x) => !x.buyerIsMaker).length / tape.length : undefined;
  const s3: Signal = basis === undefined ? 'neutral' : basis <= -0.0005 ? 'good' : basis >= 0.0008 ? 'wait' : 'neutral';

  const score = (s: Signal) => (s === 'good' ? 2 : s === 'neutral' ? 1 : 0);
  const cards = [
    { id: 'discount', signal: s1 },
    { id: 'smart', signal: s2 },
    { id: 'mood', signal: s3 },
  ];
  const top = [...cards].sort((a, b) => score(b.signal) - score(a.signal))[0];
  const best = score(top.signal) === 2 ? top.id : null;
  const pct = (v: number, d = 1) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
  const badge = (s: Signal) => <span className={`sig sig-${s}`}>{t.sig[s]}</span>;

  return (
    <section className="card strat-card" aria-label={t.stratTitle}>
      <div className="strat-head">
        <div>
          <div className="strat-title"><span className="orb sm" aria-hidden /> {t.stratTitle}</div>
          <p className="muted">{t.stratSub}</p>
        </div>
        <div className="pair-tabs" role="tablist" aria-label={t.stratAsset}>
          {ASSETS.map((a) => (
            <button key={a} role="tab" aria-selected={a === asset} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}>
              <span className={`coin coin-${a.toLowerCase()}`} />{a}
            </button>
          ))}
        </div>
      </div>

      <div className="strat-grid">
        {/* 1. HSKSwap discount buy */}
        <article className={`strat ${best === 'discount' ? 'best' : ''}`}>
          <header>{best === 'discount' && <span className="best-tag">{t.stratBest}</span>}<b>{t.s1Name}</b>{badge(s1)}</header>
          <p className="strat-rule">{t.s1Rule(asset)}</p>
          <div className="strat-now">
            <span className="label">{t.stratNow}</span>
            {gap === undefined ? <span className="muted">{t.stratNoData}</span>
              : <span>{t.s1Now(asset, q?.pool !== undefined ? `$${fmtPrice(q.pool)}` : '—', pct(gap, 2))}</span>}
          </div>
          <div className="strat-bt muted">{t.stratLiveOnly}</div>
          <button className="btn-ghost wide" onClick={() => onAsk(t.s1Prompt(asset))}>{t.stratPlan}</button>
        </article>

        {/* 2. Smart DCA */}
        <article className={`strat ${best === 'smart' ? 'best' : ''}`}>
          <header>{best === 'smart' && <span className="best-tag">{t.stratBest}</span>}<b>{t.s2Name}</b>{badge(s2)}</header>
          <p className="strat-rule">{t.s2Rule}</p>
          <div className="strat-now">
            <span className="label">{t.stratNow}</span>
            {bt ? <span>{t.s2Now(pct(bt.vsMa), `×${bt.mult.toFixed(2)}`)}</span> : <span className="muted">{err ? t.stratNoData : t.stratLoading}</span>}
          </div>
          <div className="strat-bt">
            <span className="label">{t.stratBacktest(asset)}</span>
            {bt ? (
              <>
                <div className="bt-row"><span>{t.btSmart}</span><b>${fmtPrice(bt.sAvg)}</b></div>
                <div className="bt-row muted"><span>{t.btPlain}</span><span>${fmtPrice(bt.pAvg)}</span></div>
                <div className={`bt-delta ${bt.better < 0 ? 'pos' : 'neg'}`}>{t.btDelta(pct(bt.better, 2))}</div>
              </>
            ) : <span className="skel" style={{ width: '70%' }} />}
          </div>
          <button className="btn-ghost wide" onClick={() => onAsk(t.s2Prompt(asset))}>{t.stratPlan}</button>
        </article>

        {/* 3. Futures mood */}
        <article className={`strat ${best === 'mood' ? 'best' : ''}`}>
          <header>{best === 'mood' && <span className="best-tag">{t.stratBest}</span>}<b>{t.s3Name}</b>{badge(s3)}</header>
          <p className="strat-rule">{t.s3Rule}</p>
          <div className="strat-now">
            <span className="label">{t.stratNow}</span>
            {basis === undefined ? <span className="muted">{t.stratLoading}</span>
              : <span>{t.s3Now(pct(basis, 3), buyShare === undefined ? '—' : `${Math.round(buyShare * 100)}%`)}</span>}
          </div>
          <div className="strat-bt muted">{t.stratLiveOnly}</div>
          <button className="btn-ghost wide" onClick={() => onAsk(t.s3Prompt)}>{t.stratPlan}</button>
        </article>
      </div>
      <p className="strat-foot muted">{t.stratFoot}</p>
    </section>
  );
}
