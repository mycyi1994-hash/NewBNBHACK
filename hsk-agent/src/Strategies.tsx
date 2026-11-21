// Moa strategy picks under the chart, Revolut-style: tabs for the strategies, one big pick with a single number,
// one visual and one button. Rules are plain arithmetic on live data; nothing here is a model guess.
// - Smart DCA: buy more below the 20-day average; backtested on 90 days of Gate daily candles vs plain DCA.
// - HSKSwap discount buy: live pool price vs Gate (no pool history, so a live gauge instead of a backtest).
// - Futures mood: HashKey perp mark vs index and the buyer share of recent trades (live gauge).
import { useEffect, useState, type ReactNode } from 'react';
import type { Asset } from './intent.ts';
import { ASSETS } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import type { Trade } from './cex.ts';

type Signal = 'good' | 'neutral' | 'wait';
type Id = 'smart' | 'discount' | 'mood';
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

/** $10 a day for the last 90 days: plain DCA vs "more below the 20-day average" (x0.5 … x2), with running average costs. */
function backtest(days: Daily[]) {
  const n = 90, base = 10;
  if (days.length < n + 21) return null;
  let pSpent = 0, pCoins = 0, sSpent = 0, sCoins = 0;
  const plain: number[] = [], smart: number[] = [];
  for (let i = days.length - n; i < days.length; i++) {
    const px = days[i].close;
    const ma = avg(days.slice(i - 20, i).map((d) => d.close));
    pSpent += base; pCoins += base / px;
    const amt = base * clamp(ma / px, 0.5, 2);
    sSpent += amt; sCoins += amt / px;
    plain.push(pSpent / pCoins); smart.push(sSpent / sCoins);
  }
  const last = days[days.length - 1].close;
  const ma20 = avg(days.slice(-21, -1).map((d) => d.close)); // previous 20 days, same as the backtest
  return { plain, smart, better: smart[n - 1] / plain[n - 1] - 1, mult: clamp(ma20 / last, 0.5, 2), vsMa: last / ma20 - 1 };
}

/** Two running average-cost lines; the smart one is filled. */
function CostChart({ smart, plain, labels }: { smart: number[]; plain: number[]; labels: [string, string] }) {
  const W = 600, H = 150, pad = 8;
  const all = [...smart, ...plain];
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const pt = (v: number, i: number, n: number) => `${(i / (n - 1)) * W},${pad + (1 - (v - lo) / span) * (H - pad * 2)}`;
  const line = (xs: number[]) => xs.map((v, i) => pt(v, i, xs.length)).join(' ');
  return (
    <div className="cost-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${labels[0]} / ${labels[1]}`}>
        <defs>
          <linearGradient id="smartFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#6d4ce0" stopOpacity=".18" />
            <stop offset="1" stopColor="#6d4ce0" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,${H} ${line(smart)} ${W},${H}`} fill="url(#smartFill)" />
        <polyline points={line(plain)} fill="none" stroke="#b9b3ab" strokeWidth="2" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
        <polyline points={line(smart)} fill="none" stroke="#6d4ce0" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="cost-legend">
        <span><i className="lg-smart" />{labels[0]}</span>
        <span><i className="lg-plain" />{labels[1]}</span>
      </div>
    </div>
  );
}

/** Where today's value sits between "buy" and "wait" zones. */
function Gauge({ value, min, max, left, right, mark }: { value: number; min: number; max: number; left: string; right: string; mark: string }) {
  const pos = clamp((value - min) / (max - min), 0, 1) * 100;
  return (
    <div className="gauge">
      <div className="gauge-track"><span className="gauge-mark" style={{ left: `${pos}%` }}><b>{mark}</b></span></div>
      <div className="gauge-labels"><span className="pos">{left}</span><span className="muted">0</span><span className="warn">{right}</span></div>
    </div>
  );
}

export default function Strategies({ quotes, mark, index, tape, onAsk }: {
  quotes: Quote[]; mark?: number; index?: number; tape: Trade[]; onAsk: (prompt: string) => void;
}) {
  const { t } = useT();
  const [asset, setAsset] = useState<Asset>('ETH');
  const [days, setDays] = useState<Daily[] | null>(null);
  const [err, setErr] = useState(false);
  const [picked, setPicked] = useState<Id | null>(null);

  useEffect(() => {
    let alive = true;
    setDays(null); setErr(false);
    gateDaily(asset).then((d) => alive && setDays(d), () => alive && setErr(true));
    return () => { alive = false; };
  }, [asset]);

  const pct = (v: number, d = 2) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
  const bt = days ? backtest(days) : null;
  const q = quotes.find((x) => x.asset === asset);
  const gap = q?.gap;
  const basis = mark !== undefined && index ? mark / index - 1 : undefined;
  const buyShare = tape.length ? tape.filter((x) => !x.buyerIsMaker).length / tape.length : undefined;

  const signal: Record<Id, Signal> = {
    smart: !bt ? 'neutral' : bt.vsMa <= -0.02 ? 'good' : bt.vsMa >= 0.05 ? 'wait' : 'neutral',
    discount: gap === undefined ? 'neutral' : gap <= -0.003 ? 'good' : gap >= 0.003 ? 'wait' : 'neutral',
    mood: basis === undefined ? 'neutral' : basis <= -0.0005 ? 'good' : basis >= 0.0008 ? 'wait' : 'neutral',
  };
  const order: Id[] = ['smart', 'discount', 'mood'];
  const rank = (s: Signal) => (s === 'good' ? 2 : s === 'neutral' ? 1 : 0);
  const recommended = [...order].sort((a, b) => rank(signal[b]) - rank(signal[a]))[0];
  const id = picked ?? recommended;
  const name: Record<Id, string> = { smart: t.s2Name, discount: t.s1Name, mood: t.s3Name };

  let big: string = '—', bigLabel = '', sub = '', today = '', visual: ReactNode = <div className="skel-block strat-visual-skel" />, prompt = '';
  if (id === 'smart') {
    bigLabel = t.bigAvg; sub = t.subSmart(asset); prompt = t.s2Prompt(asset);
    if (bt) {
      big = pct(bt.better);
      today = t.s2Now(pct(bt.vsMa, 1), `×${bt.mult.toFixed(2)}`);
      visual = <CostChart smart={bt.smart} plain={bt.plain} labels={[`${t.btSmart} $${fmtPrice(bt.smart[bt.smart.length - 1])}`, `${t.btPlain} $${fmtPrice(bt.plain[bt.plain.length - 1])}`]} />;
    } else if (err) { today = t.stratNoData; visual = null; }
  } else if (id === 'discount') {
    bigLabel = t.bigGap; sub = t.subDiscount(asset); prompt = t.s1Prompt(asset);
    if (gap !== undefined) {
      big = pct(gap);
      today = t.s1Now(asset, q?.pool !== undefined ? `$${fmtPrice(q.pool)}` : '—', pct(gap));
      visual = <Gauge value={gap} min={-0.02} max={0.02} left={t.zoneCheap} right={t.zoneWait} mark={pct(gap)} />;
    }
  } else {
    bigLabel = t.bigBasis; sub = t.subMood; prompt = t.s3Prompt;
    if (basis !== undefined) {
      big = pct(basis, 3);
      today = t.s3Now(pct(basis, 3), buyShare === undefined ? '—' : `${Math.round(buyShare * 100)}%`);
      visual = <Gauge value={basis} min={-0.002} max={0.002} left={t.zoneFear} right={t.zoneHot} mark={pct(basis, 3)} />;
    }
  }

  return (
    <section className="card strat-card" aria-label={t.stratTitle}>
      <div className="strat-top">
        <div className="strat-title"><span className="orb sm" aria-hidden /> {t.stratTitle}</div>
        <div className="coin-switch" role="tablist" aria-label={t.stratAsset}>
          {ASSETS.map((a) => (
            <button key={a} role="tab" aria-selected={a === asset} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}>
              <span className={`coin coin-${a.toLowerCase()}`} />{a}
            </button>
          ))}
        </div>
      </div>

      <div className="strat-tabs" role="tablist">
        {order.map((k) => (
          <button key={k} role="tab" aria-selected={k === id} className={k === id ? 'on' : ''} onClick={() => setPicked(k)}>
            {name[k]}{k === recommended && rank(signal[k]) === 2 && <span className="rec">✦ {t.stratRec}</span>}
          </button>
        ))}
      </div>

      <div className="strat-pick" key={id + asset}>
        <div className="pick-head">
          <div>
            <div className="pick-label">{bigLabel}</div>
            <div className={`pick-big ${id === 'smart' ? (bt && bt.better < 0 ? 'pos' : '') : ''}`}>{big}</div>
            <div className="pick-sub muted">{sub}</div>
          </div>
          <span className={`sig sig-${signal[id]}`}>{t.sig[signal[id]]}</span>
        </div>
        {visual}
        {today && <p className="pick-today"><span>{t.stratNow}</span>{today}</p>}
        <button className="btn-primary wide pick-cta" onClick={() => onAsk(prompt)}>{t.stratPlan}</button>
      </div>
      <p className="strat-foot muted">{t.stratFoot}</p>
    </section>
  );
}
